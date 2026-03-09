import { Router } from "express";
import { discoverTrends, analyzeTrendRelevance } from "../services/trendDiscovery.js";
import { generateScript } from "../services/scriptGeneration.js";
import { generateCaption, generateHashtags } from "../services/captionGeneration.js";
import { generateImage, buildPromptFromCharacter } from "../services/imageGeneration.js";

const router = Router();

// ─── PIPELINE ITEMS ──────────────────────────────────────────

// GET /api/pipeline — list all pipeline items
router.get("/", async (req, res) => {
  try {
    const where = {};
    if (req.query.stage) where.stage = req.query.stage;
    if (req.query.character_id) where.characterId = req.query.character_id;

    const items = await req.prisma.pipelineItem.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        script: { include: { trend: true } },
        character: { select: { id: true, name: true, characterId: true, niche: true } },
        content: { select: { id: true, title: true, status: true } },
      },
    });
    res.json(items);
  } catch (err) {
    console.error("GET /pipeline error:", err);
    res.status(500).json({ error: "Failed to fetch pipeline items" });
  }
});

// ─── TRENDS (must be before /:id wildcard) ──────────────────────

// GET /api/pipeline/trends — list all saved trends
router.get("/trends", async (req, res) => {
  try {
    const where = {};
    if (req.query.platform) where.platform = req.query.platform;
    if (req.query.status) where.status = req.query.status;

    const trends = await req.prisma.trend.findMany({
      where,
      orderBy: { trendScore: "desc" },
      include: { scripts: { select: { id: true, title: true, status: true } } },
    });
    res.json(trends);
  } catch (err) {
    console.error("GET /pipeline/trends error:", err);
    res.status(500).json({ error: "Failed to fetch trends" });
  }
});

// GET /api/pipeline/scripts — list all scripts
router.get("/scripts", async (req, res) => {
  try {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.character_id) where.characterId = req.query.character_id;

    const scripts = await req.prisma.script.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        trend: { select: { id: true, topic: true, trendScore: true } },
        character: { select: { id: true, name: true, niche: true } },
        pipelineItems: { select: { id: true, stage: true } },
      },
    });
    res.json(scripts);
  } catch (err) {
    console.error("GET /pipeline/scripts error:", err);
    res.status(500).json({ error: "Failed to fetch scripts" });
  }
});

// ─── WILDCARD ROUTES (after specific paths) ─────────────────────

// GET /api/pipeline/:id — single pipeline item
router.get("/:id", async (req, res) => {
  try {
    const item = await req.prisma.pipelineItem.findUnique({
      where: { id: req.params.id },
      include: {
        script: { include: { trend: true } },
        character: true,
        content: true,
      },
    });
    if (!item) return res.status(404).json({ error: "Pipeline item not found" });
    res.json(item);
  } catch (err) {
    console.error("GET /pipeline/:id error:", err);
    res.status(500).json({ error: "Failed to fetch pipeline item" });
  }
});

// DELETE /api/pipeline/:id
router.delete("/:id", async (req, res) => {
  try {
    await req.prisma.pipelineItem.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /pipeline/:id error:", err);
    res.status(500).json({ error: "Failed to delete pipeline item" });
  }
});

// ─── TREND DISCOVERY ────────────────────────────────────────────

// POST /api/pipeline/discover-trends — discover new trends
router.post("/discover-trends", async (req, res) => {
  try {
    const { platform = "TikTok", niche = "Lifestyle", count = 5, characterId } = req.body;

    // Discover trends
    const trends = discoverTrends(platform, niche, count);

    // If character provided, analyze relevance
    let character = null;
    if (characterId) {
      character = await req.prisma.character.findUnique({ where: { id: characterId } });
    }

    // Save trends to DB and add relevance scores
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
          status: "new",
        },
      });

      const relevance = character ? analyzeTrendRelevance(trend, character) : null;
      savedTrends.push({ ...saved, relevance });
    }

    res.status(201).json({
      count: savedTrends.length,
      platform,
      niche,
      trends: savedTrends,
    });
  } catch (err) {
    console.error("POST /pipeline/discover-trends error:", err);
    res.status(500).json({ error: "Failed to discover trends" });
  }
});

// ─── SCRIPTS ─────────────────────────────────────────────────

// POST /api/pipeline/generate-script — generate a script from trend + character
router.post("/generate-script", async (req, res) => {
  try {
    const { trendId, characterId, platform, duration, tone, contentType } = req.body;

    if (!characterId) return res.status(400).json({ error: "characterId is required" });

    // Fetch trend and character
    const trend = trendId ? await req.prisma.trend.findUnique({ where: { id: trendId } }) : null;
    const character = await req.prisma.character.findUnique({ where: { id: characterId } });
    if (!character) return res.status(404).json({ error: "Character not found" });

    // Generate script
    const scriptData = generateScript(
      trend || { topic: "Trending content", platform: platform || "TikTok" },
      character,
      { platform, duration, tone, contentType }
    );

    // Save script to DB
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

    // Create pipeline item
    const pipelineItem = await req.prisma.pipelineItem.create({
      data: {
        stage: "draft",
        scriptId: script.id,
        characterId,
        platform: scriptData.platform,
      },
    });

    // Update trend status if used
    if (trendId) {
      await req.prisma.trend.update({
        where: { id: trendId },
        data: { status: "scripted" },
      });
    }

    res.status(201).json({
      script,
      pipelineItem,
      durationGuidance: scriptData.durationGuidance,
      characterNotes: scriptData.characterNotes,
    });
  } catch (err) {
    console.error("POST /pipeline/generate-script error:", err);
    res.status(500).json({ error: "Failed to generate script" });
  }
});

// ─── CONTENT GENERATION ──────────────────────────────────────

// POST /api/pipeline/generate-content — generate image/video for pipeline item
router.post("/generate-content", async (req, res) => {
  try {
    const { pipelineItemId, type = "image" } = req.body;

    if (!pipelineItemId) return res.status(400).json({ error: "pipelineItemId is required" });

    const item = await req.prisma.pipelineItem.findUnique({
      where: { id: pipelineItemId },
      include: { character: true, script: true },
    });
    if (!item) return res.status(404).json({ error: "Pipeline item not found" });

    if (type === "image") {
      // Build prompt from character + script context
      const prompt = buildPromptFromCharacter(item.character);
      const result = await generateImage(prompt, {
        aspectRatio: item.character.aspectRatio || "9:16",
      });

      // Update pipeline item
      const updated = await req.prisma.pipelineItem.update({
        where: { id: pipelineItemId },
        data: {
          imageUrl: result.imageUrl,
          stage: "content_generated",
        },
        include: { script: true, character: { select: { name: true } } },
      });

      res.json({ success: true, type: "image", pipelineItem: updated, imageUrl: result.imageUrl });
    } else {
      // Video generation would go here — using existing videoGeneration service
      res.json({
        success: false,
        message: "Video generation via pipeline coming soon. Use /api/characters/:id/generate-video directly.",
      });
    }
  } catch (err) {
    console.error("POST /pipeline/generate-content error:", err);
    res.status(500).json({ error: "Failed to generate content" });
  }
});

// ─── CAPTION GENERATION ──────────────────────────────────────

// POST /api/pipeline/generate-caption — generate caption + hashtags
router.post("/generate-caption", async (req, res) => {
  try {
    const { pipelineItemId, platform } = req.body;

    if (!pipelineItemId) return res.status(400).json({ error: "pipelineItemId is required" });

    const item = await req.prisma.pipelineItem.findUnique({
      where: { id: pipelineItemId },
      include: { character: true, script: true },
    });
    if (!item) return res.status(404).json({ error: "Pipeline item not found" });

    const targetPlatform = platform || item.platform || "TikTok";

    // Generate caption
    const captionResult = generateCaption(item.script, item.character, targetPlatform);

    // Update pipeline item
    const updated = await req.prisma.pipelineItem.update({
      where: { id: pipelineItemId },
      data: {
        caption: captionResult.caption,
        hashtags: captionResult.hashtagString,
        stage: item.stage === "content_generated" ? "review" : item.stage,
      },
      include: { script: true, character: { select: { name: true } } },
    });

    res.json({ success: true, pipelineItem: updated, captionDetails: captionResult });
  } catch (err) {
    console.error("POST /pipeline/generate-caption error:", err);
    res.status(500).json({ error: "Failed to generate caption" });
  }
});

// ─── APPROVAL WORKFLOW ───────────────────────────────────────

// POST /api/pipeline/:id/approve — approve a pipeline item
router.post("/:id/approve", async (req, res) => {
  try {
    const item = await req.prisma.pipelineItem.update({
      where: { id: req.params.id },
      data: {
        stage: "approved",
        approvedAt: new Date(),
        reviewNotes: req.body.notes || null,
      },
      include: {
        script: true,
        character: { select: { name: true, niche: true } },
      },
    });
    res.json({ success: true, pipelineItem: item });
  } catch (err) {
    console.error("POST /pipeline/:id/approve error:", err);
    res.status(500).json({ error: "Failed to approve pipeline item" });
  }
});

// POST /api/pipeline/:id/reject — reject a pipeline item
router.post("/:id/reject", async (req, res) => {
  try {
    const item = await req.prisma.pipelineItem.update({
      where: { id: req.params.id },
      data: {
        stage: "draft", // Send back to draft for rework
        rejectedAt: new Date(),
        reviewNotes: req.body.notes || "Rejected — needs revision",
      },
      include: { script: true, character: { select: { name: true } } },
    });
    res.json({ success: true, pipelineItem: item });
  } catch (err) {
    console.error("POST /pipeline/:id/reject error:", err);
    res.status(500).json({ error: "Failed to reject pipeline item" });
  }
});

// POST /api/pipeline/:id/schedule — schedule approved item to content calendar
router.post("/:id/schedule", async (req, res) => {
  try {
    const { scheduledDate, platform } = req.body;

    const item = await req.prisma.pipelineItem.findUnique({
      where: { id: req.params.id },
      include: { script: true, character: true },
    });
    if (!item) return res.status(404).json({ error: "Pipeline item not found" });
    if (item.stage !== "approved") {
      return res.status(400).json({ error: "Item must be approved before scheduling" });
    }

    // Create Content entry on the calendar
    const content = await req.prisma.content.create({
      data: {
        title: item.script?.title || "Pipeline Content",
        contentType: item.imageUrl ? "Static Image" : "Animated Video",
        platform: platform || item.platform || "TikTok",
        scheduledDate: scheduledDate || new Date().toISOString().split("T")[0],
        status: "scheduled",
        caption: item.caption,
        hashtags: item.hashtags,
        characterId: item.characterId,
      },
    });

    // Update pipeline item
    const updated = await req.prisma.pipelineItem.update({
      where: { id: req.params.id },
      data: {
        stage: "scheduled",
        contentId: content.id,
        scheduledDate: scheduledDate || new Date().toISOString().split("T")[0],
        platform: platform || item.platform,
      },
      include: {
        script: true,
        character: { select: { name: true } },
        content: true,
      },
    });

    res.json({ success: true, pipelineItem: updated, content });
  } catch (err) {
    console.error("POST /pipeline/:id/schedule error:", err);
    res.status(500).json({ error: "Failed to schedule pipeline item" });
  }
});

export default router;
