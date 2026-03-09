import { Router } from "express";
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
    console.error("GET /content error:", err);
    res.status(500).json({ error: "Failed to fetch content" });
  }
});

// GET /api/content/:id
router.get("/:id", async (req, res) => {
  try {
    const item = await req.prisma.content.findUnique({
      where: { id: req.params.id },
      include: { character: true },
    });
    if (!item) return res.status(404).json({ error: "Content not found" });
    res.json(item);
  } catch (err) {
    console.error("GET /content/:id error:", err);
    res.status(500).json({ error: "Failed to fetch content" });
  }
});

// POST /api/content — create
router.post("/", async (req, res) => {
  try {
    const item = await req.prisma.content.create({
      data: {
        title: req.body.title,
        contentType: req.body.content_type || req.body.contentType,
        platform: req.body.platform,
        scheduledDate: req.body.scheduled_date || req.body.scheduledDate,
        status: req.body.status || "scheduled",
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
    console.error("POST /content error:", err);
    res.status(500).json({ error: "Failed to create content" });
  }
});

// PUT /api/content/:id — update
router.put("/:id", async (req, res) => {
  try {
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
    if (req.body.views !== undefined) data.views = parseInt(req.body.views) || 0;
    if (req.body.likes !== undefined) data.likes = parseInt(req.body.likes) || 0;

    const item = await req.prisma.content.update({
      where: { id: req.params.id },
      data,
      include: { character: { select: { name: true } } },
    });
    res.json({ ...item, character_name: item.character?.name || "" });
  } catch (err) {
    console.error("PUT /content/:id error:", err);
    res.status(500).json({ error: "Failed to update content" });
  }
});

// DELETE /api/content/:id
router.delete("/:id", async (req, res) => {
  try {
    await req.prisma.content.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /content/:id error:", err);
    res.status(500).json({ error: "Failed to delete content" });
  }
});

export default router;
