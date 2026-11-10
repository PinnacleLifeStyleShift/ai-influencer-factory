import { secureRouter } from "../lib/secureRouter.js";
import { ApiError, sendError, routeError } from "../lib/errors.js";
import { validateBody, listLimit, SCHEMAS } from "../lib/validate.js";
import { readIdempotencyKey, isUniqueViolation } from "../lib/requests.js";
import { checkExternalUrl } from "../lib/urlSafety.js";
import {
  publishVersion, restoreDraft, snapshotOf, contentHashOf, fingerprintUrl, promptHash,
} from "../services/characterVersions.js";
import { clearanceFor, latestRights, missingForUse } from "../services/rights.js";
import { createJob } from "../services/generationJobs.js";
import { isProcessDeath } from "../services/generationGate.js";

/**
 * Runs a single paid step as a durable job (see services/generationJobs.js).
 * persist(result) stores the outcome; the step is marked applied after it.
 */
async function runAsJob(req, { jobKind, kind, input, keys, targetId }, persist) {
  const [check] = req.generationGate.preflightAll([kind]);
  const journal = await createJob(req.prisma, {
    kind: jobKind, targetType: "character", targetId, workflowKey: keys.idempotencyKey, requestHash: keys.requestHash,
    steps: [{ kind, provider: check.provider, model: check.model, idempotencyKey: keys.idempotencyKey }], by: req.principal?.id,
  });
  let code = null;
  try {
    const result = await req.generationGate.run(kind, input, { ...keys, hooks: journal.hooks });
    const out = await persist(result);
    await journal.markApplied(0);
    return out;
  } catch (err) {
    if (isProcessDeath(err)) throw err;
    code = err instanceof ApiError ? err.code : "INTERNAL_ERROR";
    // Only a paid, stored result that could not be persisted is an application failure.
    const step = await req.prisma.generationStep.findFirst({ where: { jobId: journal.jobId, index: 0 } }).catch(() => null);
    if (step && ["succeeded", "replayed"].includes(step.state)) {
      await journal.hooks.onStepState(0, "application_failed", code).catch(() => {});
    }
    throw err;
  } finally {
    await journal.finish(code).catch(() => {});
  }
}

/** A reference image URL may be sent to providers later, so unsafe ones are refused on input. */
function assertSafeReference(body) {
  const v = body?.reference_image_url ?? body?.referenceImageUrl;
  if (v === undefined || v === null || v === "") return;
  const check = checkExternalUrl(v);
  if (!check.ok) throw new ApiError("UNSAFE_URL", 400, `reference image URL refused: ${check.reason}`);
}
import { requestHash } from "../services/spendLedger.js";
import { buildPromptFromCharacter } from "../services/imageGeneration.js";

const router = secureRouter();

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
router.post("/", ["edit"], async (req, res) => {
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
    if (character.referenceImageUrl) {
      // Tracked like any other reference: fingerprinted, no rights until recorded.
      await req.prisma.characterImage.create({
        data: {
          characterId: character.id, imageUrl: character.referenceImageUrl, status: "reference",
          source: "manual", fingerprint: fingerprintUrl(character.referenceImageUrl),
        },
      });
    }
    res.status(201).json(character);
  } catch (err) {
    return routeError(res, err, "Failed to create character", "POST /characters");
  }
});

// PUT /api/characters/:id — update
router.put("/:id", ["edit"], async (req, res) => {
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

    if (data.referenceImageUrl !== undefined) {
      const current = await req.prisma.character.findUnique({ where: { id: req.params.id } });
      if (!current) throw notFound();
      // WHY: editing the URL in place would bypass reference history, rights
      // and replacement confirmation. Unchanged values (the form re-sends
      // them) are fine.
      if ((data.referenceImageUrl || null) !== (current.referenceImageUrl || null)) {
        throw new ApiError("USE_REFERENCE_WORKFLOW", 409,
          "Change the reference image by adding it as an image and promoting it (POST /api/characters/:id/images, then /reference-image)");
      }
      delete data.referenceImageUrl;
    }
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
router.delete("/:id", ["edit"], async (req, res) => {
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
router.post("/:id/generate-image", ["generate", "spend"], async (req, res) => {
  try {
    const character = await req.prisma.character.findUnique({ where: { id: req.params.id } });
    if (!character) throw notFound();

    // Candidates preview the editable draft. No reference is sent: the
    // selected image adapter declares no reference conditioning.
    const prompt = buildPromptFromCharacter(character);
    const keys = generationKeys(req, character, "image");
    const { candidate, result } = await runAsJob(req, {
      jobKind: "character.generate-image", kind: "image", targetId: character.id, keys,
      input: { prompt, options: { aspectRatio: character.aspectRatio, quality: character.qualitySetting } },
    }, async (result) => {
      const draft = snapshotOf(character);
      const draftHash = contentHashOf({ ...draft, references: [] });
      const published = character.publishedVersionId
        ? await req.prisma.characterVersion.findUnique({ where: { id: character.publishedVersionId } })
        : null;
      const generationInputs = {
        basedOn: "draft",
        draftHash,
        promptHash: promptHash(prompt),
        referencesSent: [],
        conditioning: "none",
      };

      // WHY: provider output is stored and may be forwarded later; refuse unsafe URLs.
      if (!checkExternalUrl(result.imageUrl).ok) {
        throw new ApiError("UNSAFE_MEDIA_URL", 502, "The provider returned a media URL that is not a public https URL; it was not stored",
          { reservationId: result.reservationId });
      }
      // Store the candidate and advance the counter together. A replayed result
      // (same request retried) whose candidate is already stored is returned as is.
      const index = character.imageGenerations + 1;
      return req.prisma.$transaction(async (tx) => {
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
            fingerprint: fingerprintUrl(result.imageUrl),
            // Linked to the published version only when the draft equals it.
            characterVersionId: published && contentHashOf({ ...draft, references: [] }) ===
              contentHashOf({ identity: published.identity, styling: published.styling, references: [] }) ? published.id : null,
            generationInputs,
          },
        });
      }).then((candidate) => ({ candidate, result }));
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
    // Each image shows its newest rights record and what is missing before a
    // provider may receive it.
    const withRights = await Promise.all(images.map(async (img) => {
      const rights = await latestRights(req.prisma, img.id);
      const missing = missingForUse(rights, "provider_input");
      return { ...img, rights, providerInput: { cleared: missing.length === 0, missing } };
    }));
    res.json({ referenceImageUrl: character.referenceImageUrl, images: withRights });
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
router.post("/:id/reference-image", ["references"], async (req, res) => {
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
            data: { characterId: character.id, imageUrl: character.referenceImageUrl, status: "replaced_reference", source: "manual", fingerprint: fingerprintUrl(character.referenceImageUrl) },
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

// POST /api/characters/:id/images { imageUrl } — register an existing image as a candidate
router.post("/:id/images", ["references"], async (req, res) => {
  try {
    const character = await req.prisma.character.findUnique({ where: { id: req.params.id } });
    if (!character) throw notFound();
    const url = req.body?.imageUrl;
    const check = typeof url === "string" && url.length <= 2048 ? checkExternalUrl(url) : { ok: false, reason: "imageUrl is required" };
    if (!check.ok) throw new ApiError("UNSAFE_URL", 400, `image URL refused: ${check.reason}`);
    const image = await req.prisma.characterImage.create({
      data: { characterId: character.id, imageUrl: url, status: "candidate", source: "manual", fingerprint: fingerprintUrl(url) },
    });
    res.status(201).json(image);
  } catch (err) {
    return routeError(res, err, "Failed to add image", "POST /characters/:id/images");
  }
});

// ─── Versions ───────────────────────────────────────────────

router.get("/:id/versions", async (req, res) => {
  try {
    const character = await req.prisma.character.findUnique({ where: { id: req.params.id } });
    if (!character) throw notFound();
    const versions = await req.prisma.characterVersion.findMany({
      where: { characterId: character.id }, orderBy: { version: "desc" }, take: listLimit(req),
    });
    const draft = snapshotOf(character);
    const latest = versions[0];
    // The draft differs from the latest version if identity/styling changed
    // (reference changes show up at the next publish).
    const draftChanged = !latest || contentHashOf({ ...draft, references: [] }) !==
      contentHashOf({ identity: latest.identity, styling: latest.styling, references: [] });
    res.json({ publishedVersionId: character.publishedVersionId, draftChanged, versions });
  } catch (err) {
    return routeError(res, err, "Failed to list versions", "GET /characters/:id/versions");
  }
});

router.get("/:id/versions/:version", async (req, res) => {
  try {
    const n = Number(req.params.version);
    if (!Number.isInteger(n) || n < 1) throw new ApiError("VALIDATION_FAILED", 400, "version must be a positive whole number");
    const v = await req.prisma.characterVersion.findUnique({ where: { characterId_version: { characterId: req.params.id, version: n } } });
    if (!v) throw new ApiError("NOT_FOUND", 404, "Version not found");
    res.json(v);
  } catch (err) {
    return routeError(res, err, "Failed to read version", "GET /characters/:id/versions/:version");
  }
});

// POST /api/characters/:id/versions { note? } — publish the current draft (immutable)
router.post("/:id/versions", ["edit"], async (req, res) => {
  try {
    const note = req.body?.note;
    if (note !== undefined && (typeof note !== "string" || note.length > 500)) {
      throw new ApiError("VALIDATION_FAILED", 400, "note must be a string of at most 500 characters");
    }
    const { version, unchanged } = await publishVersion(req.prisma, req.params.id, { by: req.principal?.id, note });
    res.status(unchanged ? 200 : 201).json({ version, unchanged });
  } catch (err) {
    return routeError(res, err, "Failed to publish version", "POST /characters/:id/versions");
  }
});

// POST /api/characters/:id/versions/:version/restore — copy a version into the draft
router.post("/:id/versions/:version/restore", ["edit"], async (req, res) => {
  try {
    const n = Number(req.params.version);
    if (!Number.isInteger(n) || n < 1) throw new ApiError("VALIDATION_FAILED", 400, "version must be a positive whole number");
    const character = await restoreDraft(req.prisma, req.params.id, n);
    res.json({ character, restoredFrom: n });
  } catch (err) {
    return routeError(res, err, "Failed to restore version", "POST /characters/:id/versions/:version/restore");
  }
});

// POST /api/characters/:id/generate-video — through the injected generation gate
router.post("/:id/generate-video", ["generate", "spend"], async (req, res) => {
  try {
    const character = await req.prisma.character.findUnique({ where: { id: req.params.id } });
    if (!character) return sendError(res, new ApiError("NOT_FOUND", 404, "Character not found"));

    const duration = String(req.body?.duration ?? "5");
    if (!["5", "10"].includes(duration)) {
      return sendError(res, new ApiError("VALIDATION_FAILED", 400, "duration must be 5 or 10"));
    }
    // WHY explicit: sending the reference image to a provider is a decision
    // that needs the adapter to support it and the image's rights to allow it.
    const source = req.body?.source ?? "text";
    if (!["text", "reference"].includes(source)) {
      return sendError(res, new ApiError("VALIDATION_FAILED", 400, "source must be text or reference"));
    }
    let imageUrl = null;
    if (source === "reference") {
      if (!req.generationGate.capabilities("video")?.sourceImage) {
        throw new ApiError("REFERENCE_CONDITIONING_UNSUPPORTED", 409, "The selected video provider does not accept a source image");
      }
      if (!character.referenceImageUrl) throw new ApiError("REFERENCE_NOT_CLEARED", 409, "This character has no reference image");
      const ref = await req.prisma.characterImage.findFirst({
        where: { characterId: character.id, imageUrl: character.referenceImageUrl }, orderBy: { createdAt: "desc" },
      });
      const clearance = ref ? await clearanceFor(req.prisma, ref.id, "provider_input") : { cleared: false, missing: ["tracked reference image"] };
      if (!clearance.cleared) {
        throw new ApiError("REFERENCE_NOT_CLEARED", 409,
          "The reference image may not be sent to a provider yet", { missing: clearance.missing });
      }
      imageUrl = character.referenceImageUrl;
    }
    const result = await runAsJob(req, {
      jobKind: "character.generate-video", kind: "video", targetId: character.id,
      keys: generationKeys(req, character, `video-${source}`),
      input: { imageUrl, prompt: buildPromptFromCharacter(character), options: { aspectRatio: character.aspectRatio === "9:16" ? "9:16" : "16:9", duration } },
    }, async (r) => r);
    res.json({ videoUrl: result.videoUrl, character });
  } catch (err) {
    return routeError(res, err, "Failed to generate video", "POST /characters/:id/generate-video");
  }
});

export default router;
