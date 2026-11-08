import { Router } from "express";
import { ApiError, sendError } from "../lib/errors.js";
import { readIdempotencyKey, isUniqueViolation } from "../lib/requests.js";
import { requestHash } from "../services/spendLedger.js";
import { buildPromptFromCharacter, generateImage } from "../services/imageGeneration.js";
import { generateVideo } from "../services/videoGeneration.js";

const router = Router();

// Arbitrary constant for a transaction-scoped advisory lock that serialises
// character-ID allocation across concurrent requests and processes.
const CHARACTER_ID_LOCK_KEY = 815_120_002;

/**
 * Allocates the next INFL-### label from the highest existing number (not the
 * row count, which repeats after deletions) inside a locked transaction. The
 * unique constraint on character_id remains the final backstop.
 */
async function createWithNextCharacterId(prisma, data, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHARACTER_ID_LOCK_KEY})`;
        const [{ max }] = await tx.$queryRaw`
          SELECT COALESCE(MAX(CAST(SUBSTRING(character_id FROM '^INFL-([0-9]+)$') AS INTEGER)), 0) AS max
          FROM characters`;
        const characterId = `INFL-${String(Number(max) + 1).padStart(3, "0")}`;
        return tx.character.create({ data: { ...data, characterId } });
      });
    } catch (err) {
      if (!isUniqueViolation(err) || i === attempts - 1) throw err;
    }
  }
  throw new Error("unreachable");
}

/**
 * Idempotency for character generation: a client Idempotency-Key, or a server
 * key tied to the character's current version (updatedAt), so a double click
 * cannot buy the same generation twice.
 */
function generationKeys(req, character, kind) {
  const clientKey = readIdempotencyKey(req);
  return {
    idempotencyKey: clientKey
      ? `char|client:${clientKey}:${kind}`
      : `char|${character.id}:${kind}:${new Date(character.updatedAt).toISOString()}`,
    requestHash: requestHash({ op: `character.generate-${kind}`, characterId: character.id }),
  };
}

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
    const character = await createWithNextCharacterId(req.prisma, {
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

// POST /api/characters/:id/generate-image — through the injected generation gate
router.post("/:id/generate-image", async (req, res) => {
  try {
    const character = await req.prisma.character.findUnique({ where: { id: req.params.id } });
    if (!character) return res.status(404).json({ error: "Character not found", code: "NOT_FOUND" });

    const imageUrl = await generateImage(
      req.generationGate,
      buildPromptFromCharacter(character),
      { aspectRatio: character.aspectRatio, quality: character.qualitySetting },
      generationKeys(req, character, "image")
    );

    const updated = await req.prisma.character.update({
      where: { id: req.params.id },
      data: { referenceImageUrl: imageUrl },
    });
    res.json(updated);
  } catch (err) {
    if (err instanceof ApiError) return sendError(res, err);
    console.error("POST /characters/:id/generate-image error:", err.message);
    res.status(500).json({ error: "Failed to generate image", code: "INTERNAL_ERROR" });
  }
});

// POST /api/characters/:id/generate-video — through the injected generation gate
router.post("/:id/generate-video", async (req, res) => {
  try {
    const character = await req.prisma.character.findUnique({ where: { id: req.params.id } });
    if (!character) return res.status(404).json({ error: "Character not found", code: "NOT_FOUND" });

    const duration = String(req.body?.duration ?? "5");
    if (!["5", "10"].includes(duration)) {
      return sendError(res, new ApiError("VALIDATION_FAILED", 400, "duration must be 5 or 10"));
    }
    const result = await generateVideo(
      req.generationGate,
      {
        imageUrl: character.referenceImageUrl || null,
        prompt: buildPromptFromCharacter(character),
        options: { aspectRatio: character.aspectRatio === "9:16" ? "9:16" : "16:9", duration },
      },
      generationKeys(req, character, "video")
    );
    res.json({ videoUrl: result.videoUrl, character });
  } catch (err) {
    if (err instanceof ApiError) return sendError(res, err);
    console.error("POST /characters/:id/generate-video error:", err.message);
    res.status(500).json({ error: "Failed to generate video", code: "INTERNAL_ERROR" });
  }
});

export default router;
