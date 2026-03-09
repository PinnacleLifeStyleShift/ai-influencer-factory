import { Router } from "express";
const router = Router();

// GET /api/characters — list all
router.get("/", async (req, res) => {
  try {
    const characters = await req.prisma.character.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { content: true, submissions: true } } },
    });
    res.json(characters);
  } catch (err) {
    console.error("GET /characters error:", err);
    res.status(500).json({ error: "Failed to fetch characters" });
  }
});

// GET /api/characters/:id — single character with relations
router.get("/:id", async (req, res) => {
  try {
    const character = await req.prisma.character.findUnique({
      where: { id: req.params.id },
      include: {
        content: { orderBy: { scheduledDate: "desc" } },
        submissions: { include: { campaign: true } },
      },
    });
    if (!character) return res.status(404).json({ error: "Character not found" });
    res.json(character);
  } catch (err) {
    console.error("GET /characters/:id error:", err);
    res.status(500).json({ error: "Failed to fetch character" });
  }
});

// POST /api/characters — create
router.post("/", async (req, res) => {
  try {
    // Auto-generate character_id
    const count = await req.prisma.character.count();
    const characterId = `INFL-${String(count + 1).padStart(3, "0")}`;

    const character = await req.prisma.character.create({
      data: {
        characterId,
        name: req.body.name,
        characterType: req.body.character_type || req.body.characterType,
        niche: req.body.niche,
        persona: req.body.persona,
        gender: req.body.gender,
        ethnicity: req.body.ethnicity,
        eyeColor: req.body.eye_color || req.body.eyeColor,
        age: req.body.age,
        skinConditions: req.body.skin_conditions || req.body.skinConditions,
        advancedFeatures: req.body.advanced_features || req.body.advancedFeatures,
        optionalPrompt: req.body.optional_prompt || req.body.optionalPrompt,
        aspectRatio: req.body.aspect_ratio || req.body.aspectRatio || "9:16",
        qualitySetting: req.body.quality_setting || req.body.qualitySetting || "4K",
        referenceImageUrl: req.body.reference_image_url || req.body.referenceImageUrl,
        bopaBackground: req.body.bopa_background || req.body.bopaBackground,
        bopaOutfit: req.body.bopa_outfit || req.body.bopaOutfit,
        bopaPoses: req.body.bopa_poses || req.body.bopaPoses,
        bopaAngles: req.body.bopa_angles || req.body.bopaAngles,
        targetPlatforms: req.body.target_platforms || req.body.targetPlatforms || [],
        status: req.body.status || "active",
        followerCount: parseInt(req.body.follower_count || req.body.followerCount) || 0,
        totalViews: parseInt(req.body.total_views || req.body.totalViews) || 0,
        engagementRate: req.body.engagement_rate || req.body.engagementRate || "0.00",
        notes: req.body.notes,
      },
    });
    res.status(201).json(character);
  } catch (err) {
    console.error("POST /characters error:", err);
    res.status(500).json({ error: "Failed to create character" });
  }
});

// PUT /api/characters/:id — update
router.put("/:id", async (req, res) => {
  try {
    const data = {};
    const fields = {
      name: "name", character_type: "characterType", characterType: "characterType",
      niche: "niche", persona: "persona", gender: "gender", ethnicity: "ethnicity",
      eye_color: "eyeColor", eyeColor: "eyeColor", age: "age",
      skin_conditions: "skinConditions", skinConditions: "skinConditions",
      advanced_features: "advancedFeatures", advancedFeatures: "advancedFeatures",
      optional_prompt: "optionalPrompt", optionalPrompt: "optionalPrompt",
      aspect_ratio: "aspectRatio", aspectRatio: "aspectRatio",
      quality_setting: "qualitySetting", qualitySetting: "qualitySetting",
      reference_image_url: "referenceImageUrl", referenceImageUrl: "referenceImageUrl",
      bopa_background: "bopaBackground", bopaBackground: "bopaBackground",
      bopa_outfit: "bopaOutfit", bopaOutfit: "bopaOutfit",
      bopa_poses: "bopaPoses", bopaPoses: "bopaPoses",
      bopa_angles: "bopaAngles", bopaAngles: "bopaAngles",
      target_platforms: "targetPlatforms", targetPlatforms: "targetPlatforms",
      status: "status", notes: "notes",
      engagement_rate: "engagementRate", engagementRate: "engagementRate",
    };

    for (const [bodyKey, prismaKey] of Object.entries(fields)) {
      if (req.body[bodyKey] !== undefined) data[prismaKey] = req.body[bodyKey];
    }
    if (req.body.follower_count !== undefined || req.body.followerCount !== undefined)
      data.followerCount = parseInt(req.body.follower_count ?? req.body.followerCount) || 0;
    if (req.body.total_views !== undefined || req.body.totalViews !== undefined)
      data.totalViews = parseInt(req.body.total_views ?? req.body.totalViews) || 0;

    const character = await req.prisma.character.update({
      where: { id: req.params.id },
      data,
    });
    res.json(character);
  } catch (err) {
    console.error("PUT /characters/:id error:", err);
    res.status(500).json({ error: "Failed to update character" });
  }
});

// DELETE /api/characters/:id
router.delete("/:id", async (req, res) => {
  try {
    await req.prisma.character.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /characters/:id error:", err);
    res.status(500).json({ error: "Failed to delete character" });
  }
});

// POST /api/characters/:id/generate-image — AI image generation via Higgsfield
router.post("/:id/generate-image", async (req, res) => {
  try {
    // 1. Fetch character
    const character = await req.prisma.character.findUnique({
      where: { id: req.params.id },
    });
    if (!character) return res.status(404).json({ error: "Character not found" });

    // 2. Build prompt and generate image
    const { buildPromptFromCharacter, generateImage } = await import("../services/imageGeneration.js");
    const prompt = buildPromptFromCharacter(character);
    const imageUrl = await generateImage(prompt, {
      aspectRatio: character.aspectRatio,
      quality: character.qualitySetting,
    });

    // 3. Save image URL to database
    const updated = await req.prisma.character.update({
      where: { id: req.params.id },
      data: { referenceImageUrl: imageUrl },
    });

    res.json(updated);
  } catch (err) {
    console.error("POST /characters/:id/generate-image error:", err);

    if (err.message.includes("HIGGSFIELD_API_KEY")) {
      return res.status(503).json({ error: "Image generation service is not configured" });
    }
    if (err.message.includes("Higgsfield API error")) {
      return res.status(502).json({ error: err.message });
    }

    res.status(500).json({ error: "Failed to generate image" });
  }
});

export default router;
