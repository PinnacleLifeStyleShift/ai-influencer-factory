import { Router } from "express";
import { validateBody, listLimit, SCHEMAS } from "../lib/validate.js";
import { ApiError, sendError, routeError } from "../lib/errors.js";

/**
 * Generic content routes are a planning calendar. They can never mark content
 * scheduled or published:
 *  - "scheduled" content is created only by POST /api/pipeline/:id/schedule
 *    from an approved, unchanged pipeline revision (it carries scheduleKey);
 *  - "published" needs a platform-confirmed publisher, which does not exist.
 * For content created from an approved revision, publish-relevant fields and
 * status are locked here; changes go through the pipeline and need re-approval.
 */
const LOCKED_FIELDS = ["title", "contentType", "platform", "caption", "hashtags", "motionPrompt"];

function assertStatusChange(status, existing) {
  if (status === undefined || (existing && status === existing.status)) return;
  if (status === "published") {
    throw new ApiError("PUBLISHING_NOT_ENABLED", 409,
      "Publishing is not enabled. Content cannot be marked published without platform confirmation.");
  }
  if (status === "scheduled") {
    throw new ApiError("APPROVAL_REQUIRED", 409,
      "Content can only be scheduled from an approved pipeline revision (POST /api/pipeline/:id/schedule)");
  }
  if (status !== "draft") {
    throw new ApiError("VALIDATION_FAILED", 400, `Unsupported status: ${String(status).slice(0, 40)}`);
  }
  if (existing?.scheduleKey) {
    throw new ApiError("APPROVAL_LOCKED", 409, "Status of approved, scheduled content cannot be changed here");
  }
}
const router = Router();

// GET /api/content — list all, optional ?month=2026-03
router.get("/", async (req, res) => {
  try {
    const where = {};
    if (req.query.month) {
      // Filter by month prefix e.g. "2026-03"
      where.scheduledDate = { startsWith: req.query.month };
    }
    if (req.query.character_id) {
      where.characterId = req.query.character_id;
    }

    const content = await req.prisma.content.findMany({
      take: listLimit(req),
      where,
      orderBy: { scheduledDate: "asc" },
      include: { character: { select: { id: true, name: true, characterId: true } } },
    });

    // Map character name for frontend compatibility
    const mapped = content.map((c) => ({
      ...c,
      character_name: c.character?.name || "",
      character_id: c.characterId,
    }));
    res.json(mapped);
  } catch (err) {
    return routeError(res, err, "Failed to fetch content", "GET /content");
  }
});

// GET /api/content/:id
router.get("/:id", async (req, res) => {
  try {
    const item = await req.prisma.content.findUnique({
      where: { id: req.params.id },
      include: { character: true },
    });
    if (!item) return sendError(res, new ApiError("NOT_FOUND", 404, "Content not found"));
    res.json(item);
  } catch (err) {
    return routeError(res, err, "Failed to fetch content", "GET /content/:id");
  }
});

// POST /api/content — create
router.post("/", async (req, res) => {
  try {
    validateBody(req.body, SCHEMAS.content);
    assertStatusChange(req.body.status, null);
    const item = await req.prisma.content.create({
      data: {
        title: req.body.title,
        contentType: req.body.content_type || req.body.contentType,
        platform: req.body.platform,
        scheduledDate: req.body.scheduled_date || req.body.scheduledDate,
        status: "draft",
        caption: req.body.caption,
        hashtags: req.body.hashtags,
        motionPrompt: req.body.motion_prompt || req.body.motionPrompt,
        notes: req.body.notes,
        characterId: req.body.character_id || req.body.characterId,
      },
      include: { character: { select: { name: true } } },
    });
    res.status(201).json({ ...item, character_name: item.character?.name || "" });
  } catch (err) {
    return routeError(res, err, "Failed to create content", "POST /content");
  }
});

// PUT /api/content/:id — update
router.put("/:id", async (req, res) => {
  try {
    validateBody(req.body, SCHEMAS.content, { partial: true });
    const existing = await req.prisma.content.findUnique({ where: { id: req.params.id } });
    if (!existing) return sendError(res, new ApiError("NOT_FOUND", 404, "Content not found"));
    assertStatusChange(req.body.status, existing);
    const data = {};
    const fields = {
      title: "title", content_type: "contentType", contentType: "contentType",
      platform: "platform", scheduled_date: "scheduledDate", scheduledDate: "scheduledDate",
      status: "status", caption: "caption", hashtags: "hashtags",
      motion_prompt: "motionPrompt", motionPrompt: "motionPrompt", notes: "notes",
    };
    for (const [bodyKey, prismaKey] of Object.entries(fields)) {
      if (req.body[bodyKey] !== undefined) data[prismaKey] = req.body[bodyKey];
    }
    if (existing.scheduleKey) {
      const locked = LOCKED_FIELDS.filter((f) => data[f] !== undefined && (data[f] ?? null) !== (existing[f] ?? null));
      if (locked.length) {
        throw new ApiError("APPROVAL_LOCKED", 409,
          `${locked.join(", ")} of approved content cannot be edited here; revise the pipeline item and re-approve`);
      }
    }
    if (data.status === existing.status) delete data.status;
    if (req.body.views !== undefined) data.views = parseInt(req.body.views) || 0;
    if (req.body.likes !== undefined) data.likes = parseInt(req.body.likes) || 0;

    const item = await req.prisma.content.update({
      where: { id: req.params.id },
      data,
      include: { character: { select: { name: true } } },
    });
    res.json({ ...item, character_name: item.character?.name || "" });
  } catch (err) {
    return routeError(res, err, "Failed to update content", "PUT /content/:id");
  }
});

// DELETE /api/content/:id
router.delete("/:id", async (req, res) => {
  try {
    await req.prisma.content.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    return routeError(res, err, "Failed to delete content", "DELETE /content/:id");
  }
});

export default router;
