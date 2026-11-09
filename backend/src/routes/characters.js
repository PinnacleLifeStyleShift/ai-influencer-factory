import { Router } from "express";
import { ApiError, sendError, routeError } from "../lib/errors.js";
import { validateBody, listLimit, SCHEMAS } from "../lib/validate.js";
import { readIdempotencyKey, isUniqueViolation } from "../lib/requests.js";
import { checkExternalUrl } from "../lib/urlSafety.js";

/** A reference image URL may be sent to providers later, so unsafe ones are refused on input. */
function assertSafeReference(body) {
  const v = body?.reference_image_url ?? body?.referenceImageUrl;
  if (v === undefined || v === null || v === "") return;
  const check = checkExternalUrl(v);
  if (!check.ok) throw new ApiError("UNSAFE_URL", 400, `reference image URL refused: ${check.reason}`);
}
import { requestHash } from "../services/spendLedger.js";
import { buildPromptFromCharacter } from "../services/imageGeneration.js";
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
 * key so a double click cannot buy the same generation twice. Image keys use
 * the monotonic imageGenerations counter (the next image is a new request
 * only once the previous one was stored); video keys use updatedAt.
 */
function generationKeys(req, character, kind) {
  const clientKey = readIdempotencyKey(req);
  const serverPart = kind === "image"
    ? `g${character.imageGenerations}`
    : new Date(character.updatedAt).toISOString();
  return {
    idempotencyKey: clientKey
      ? `char|client:${clientKey}:${kind}`
      : `char|${character.id}:${kind}:${serverPart}`,
    requestHash: requestHash({ op: `character.generate-${kind}`, characterId: character.id }),
  };
}

const notFound = () => new ApiError("NOT_FOUND", 404, "Character not found");

// GET /api/characters — list all
router.get("/", async (req, res) => {
  try {
    const characters = await req.prisma.character.findMany({
      take: listLimit(req),
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { content: true, submissions: true } } },
    });
    res.json(characters);
  } catch (err) {
    return routeError(res, err, "Failed to fetch characters", "GET /characters");
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
    if (!character) return sendError(res, new ApiError("NOT_FOUND", 404, "Character not found"));
    res.json(character);
  } catch (err) {
    return routeError(res, err, "Failed to fetch character", "GET /characters/:id");
  }
});

// POST /api/characters — create
router.post("/", async (req, res) => {
  try {
    validateBody(req.body, SCHEMAS.character);
    assertSafeReference(req.body);
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
    return routeError(res, err, "Failed to create character", "POST /characters");
  }
});

// PUT /api/characters/:id — update
router.put("/:id", async (req, res) => {
  try {
    validateBody(req.body, SCHEMAS.character, { partial: true });
    assertSafeReference(req.body);
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
    return routeError(res, err, "Failed to update character", "PUT /characters/:id");
  }
});

// DELETE /api/characters/:id
router.delete("/:id", async (req, res) => {
  try {
    await req.prisma.character.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    return routeError(res, err, "Failed to delete character", "DELETE /characters/:id");
  }
});

/**
 * POST /api/characters/:id/generate-image
 * Generates a CANDIDATE image through the injected gate. The character's
 * reference image is never changed here; promote a candidate explicitly with
 * POST /api/characters/:id/reference-image.
 */
router.post("/:id/generate-image", async (req, res) => {
  try {
    const character = await req.prisma.character.findUnique({ where: { id: req.params.id } });
    if (!character) throw notFound();

    const result = await req.generationGate.run(
      "image",
      {
        prompt: buildPromptFromCharacter(character),
        options: { aspectRatio: character.aspectRatio, quality: character.qualitySetting },
      },
      generationKeys(req, character, "image")
    );

    // WHY: provider output is stored and may be forwarded later; refuse unsafe URLs.
    if (!checkExternalUrl(result.imageUrl).ok) {
      throw new ApiError("UNSAFE_MEDIA_URL", 502, "The provider returned a media URL that is not a public https URL; it was not stored",
        { reservationId: result.reservationId });
    }
    // Store the candidate and advance the counter together. A replayed result
    // (same request retried) whose candidate is already stored is returned as is.
    const index = character.imageGenerations + 1;
    const candidate = await req.prisma.$transaction(async (tx) => {
      if (result.reservationId) {
        const existing = await tx.characterImage.findFirst({ where: { reservationId: result.reservationId } });
        if (existing) return existing;
      }
      const { count } = await tx.character.updateMany({
        where: { id: character.id, imageGenerations: character.imageGenerations },
        data: { imageGenerations: { increment: 1 } },
      });
      if (count !== 1) throw new ApiError("REVISION_CONFLICT", 409, "Character changed during generation; reload and retry");
      return tx.characterImage.create({
        data: {
          characterId: character.id,
          imageUrl: result.imageUrl,
          status: "candidate",
          source: "generated",
          provider: result.provider,
          model: result.model,
          reservationId: result.reservationId || null,
          generationIndex: index,
        },
      });
    });

    const current = await req.prisma.character.findUnique({ where: { id: character.id } });
    res.status(201).json({ candidate, character: current, replayed: result.replayed === true });
  } catch (err) {
    return routeError(res, err, "Failed to generate image", "POST /characters/:id/generate-image");
  }
});

// GET /api/characters/:id/images — candidates and replaced references, newest first
router.get("/:id/images", async (req, res) => {
  try {
    const character = await req.prisma.character.findUnique({ where: { id: req.params.id } });
    if (!character) throw notFound();
    const images = await req.prisma.characterImage.findMany({
      take: listLimit(req),
      where: { characterId: character.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ referenceImageUrl: character.referenceImageUrl, images });
  } catch (err) {
    return routeError(res, err, "Failed to list images", "GET /characters/:id/images");
  }
});

/**
 * POST /api/characters/:id/reference-image { imageId, replaceReference? }
 * Explicitly promotes a candidate to the reference image. Replacing an
 * existing reference requires replaceReference: true; the previous reference
 * is kept in history as "replaced_reference", never lost.
 */
router.post("/:id/reference-image", async (req, res) => {
  try {
    const { imageId, replaceReference } = req.body || {};
    if (!imageId || typeof imageId !== "string") {
      throw new ApiError("VALIDATION_FAILED", 400, "imageId is required");
    }
    const result = await req.prisma.$transaction(async (tx) => {
      const character = await tx.character.findUnique({ where: { id: req.params.id } });
      if (!character) throw notFound();
      const image = await tx.characterImage.findUnique({ where: { id: imageId } });
      if (!image || image.characterId !== character.id) {
        throw new ApiError("NOT_FOUND", 404, "Image not found for this character");
      }
      if (character.referenceImageUrl === image.imageUrl) return { character, image, changed: false };
      if (character.referenceImageUrl && replaceReference !== true) {
        throw new ApiError("REFERENCE_EXISTS", 409,
          "This character already has a reference image; confirm with replaceReference: true");
      }

      // Conditional update: fails if the reference changed since it was read.
      const { count } = await tx.character.updateMany({
        where: { id: character.id, referenceImageUrl: character.referenceImageUrl },
        data: { referenceImageUrl: image.imageUrl },
      });
      if (count !== 1) throw new ApiError("REVISION_CONFLICT", 409, "Reference image changed; reload and retry");

      if (character.referenceImageUrl) {
        const previous = await tx.characterImage.findFirst({
          where: { characterId: character.id, imageUrl: character.referenceImageUrl },
        });
        if (previous) {
          await tx.characterImage.update({ where: { id: previous.id }, data: { status: "replaced_reference" } });
        } else {
          await tx.characterImage.create({
            data: { characterId: character.id, imageUrl: character.referenceImageUrl, status: "replaced_reference", source: "manual" },
          });
        }
      }
      const promoted = await tx.characterImage.update({ where: { id: image.id }, data: { status: "reference" } });
      return { character: await tx.character.findUnique({ where: { id: character.id } }), image: promoted, changed: true };
    });
    res.json(result);
  } catch (err) {
    return routeError(res, err, "Failed to set reference image", "POST /characters/:id/reference-image");
  }
});

// POST /api/characters/:id/generate-video — through the injected generation gate
router.post("/:id/generate-video", async (req, res) => {
  try {
    const character = await req.prisma.character.findUnique({ where: { id: req.params.id } });
    if (!character) return sendError(res, new ApiError("NOT_FOUND", 404, "Character not found"));

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
    return routeError(res, err, "Failed to generate video", "POST /characters/:id/generate-video");
  }
});

export default router;
