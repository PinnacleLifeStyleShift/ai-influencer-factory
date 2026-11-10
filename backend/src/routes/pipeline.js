import { secureRouter } from "../lib/secureRouter.js";
import { ApiError, sendError, routeError } from "../lib/errors.js";
import {
  DESTINATIONS, serializeItem, snapshotHash, mediaTypeOf, invalidatingChange,
} from "../lib/revision.js";
import crypto from "crypto";
import { checkExternalUrl } from "../lib/urlSafety.js";
import { validateBody, listLimit, SCHEMAS } from "../lib/validate.js";
import { readIdempotencyKey, isUniqueViolation } from "../lib/requests.js";
import {
  discoverTrends, analyzeTrendRelevance, SUPPORTED_PLATFORMS, SUPPORTED_NICHES, MAX_TREND_COUNT,
} from "../services/trendDiscovery.js";
import { generateScript } from "../services/scriptGeneration.js";
import { generateCaption } from "../services/captionGeneration.js";
import { buildPromptFromCharacter } from "../services/imageGeneration.js";
import { requestHash } from "../services/spendLedger.js";
import { ensurePublishedVersion, promptSourceOf, promptHash } from "../services/characterVersions.js";
import { clearanceFor } from "../services/rights.js";
import {
  createScriptVersion, initialScriptInput, DEFAULT_DISCLOSURE, DEFAULT_EXPORT_SETTINGS,
} from "../services/scriptVersions.js";
import { measurePackage } from "../services/shotPlan.js";
import { resolveLocal, offsetLabel } from "../lib/zonedTime.js";
import { checkClaims } from "../services/claims.js";
import { createJob } from "../services/generationJobs.js";
import { settleJob } from "../services/publishing.js";
import { isProcessDeath } from "../services/generationGate.js";

const router = secureRouter();

/** Wraps a handler so ApiErrors become typed responses and others a generic 500. */
const handle = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    return routeError(res, err, `Failed: ${label}`, label);
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
  // WHY: published content is out in the world; editing the record would make
  // it disagree with what was posted.
  if (item.stage === "published") {
    throw new ApiError("ALREADY_PUBLISHED", 409, "Published items cannot be changed; create a new item instead");
  }
}

/**
 * { local: "YYYY-MM-DDTHH:mm", timezone: IANA, ambiguity?: "earlier"|"later" }
 * or null (no schedule). Stores the zone, the wall time and the UTC instant.
 */
function parseSchedule(schedule) {
  if (schedule === null) return { scheduledAt: null, scheduleTimezone: null, scheduleLocal: null, scheduledDate: null };
  if (!schedule || typeof schedule !== "object") throw invalid("schedule must be { local, timezone, ambiguity? } or null");
  const { local, timezone, ambiguity } = schedule;
  if (ambiguity !== undefined && !["earlier", "later"].includes(ambiguity)) throw invalid("schedule.ambiguity must be earlier or later");
  const r = resolveLocal(local, timezone);
  if (r.status === "invalid") throw invalid("schedule needs local as YYYY-MM-DDTHH:mm and timezone as an IANA zone (e.g. America/Los_Angeles)");
  if (r.status === "nonexistent") {
    throw new ApiError("SCHEDULE_TIME_NONEXISTENT", 422, `${local} does not exist in ${timezone} (clocks move forward that night); choose another time`);
  }
  if (r.status === "ambiguous" && !ambiguity) {
    throw new ApiError("SCHEDULE_TIME_AMBIGUOUS", 422, `${local} happens twice in ${timezone} (clocks move back that night); choose the earlier or later one`,
      { options: r.instants.map((d, i) => ({ ambiguity: i === 0 ? "earlier" : "later", utc: d.toISOString(), offset: offsetLabel(d.getTime(), timezone) })) });
  }
  const at = r.status === "ambiguous" && ambiguity === "later" ? r.instants[1] : r.instants[0];
  return { scheduledAt: at, scheduleTimezone: timezone, scheduleLocal: local, scheduledDate: local.slice(0, 10) };
}

// ─── Generation claims ───────────────────────────────────────
// WHY: a generation spends money and then takes minutes. Without a claim, a
// schedule, approval, edit or second generation could interleave with it and
// the late result would overwrite whatever happened meanwhile. The claim is
// taken atomically before any spend and every competing write checks it.

// A claim older than this is treated as abandoned (crashed process). It is
// longer than the slowest provider poll (video: 60 x 10 s). A late result from
// an abandoned attempt is still fenced out by its token.
export const GENERATION_CLAIM_TTL_MS = 20 * 60 * 1000;

/** Prisma filter: no live generation claim on the item. */
function noLiveClaim(now = Date.now()) {
  return {
    OR: [
      { generationClaim: null },
      { generationClaimedAt: { lt: new Date(now - GENERATION_CLAIM_TTL_MS) } },
    ],
  };
}

export function claimIsLive(item, now = Date.now()) {
  return Boolean(item.generationClaim) && Boolean(item.generationClaimedAt) &&
    new Date(item.generationClaimedAt).getTime() >= now - GENERATION_CLAIM_TTL_MS;
}

const generationInProgress = () =>
  new ApiError("GENERATION_IN_PROGRESS", 409, "A generation for this item is in progress; wait for it to finish");

/**
 * Applies a publish-relevant change only if nobody changed the item meanwhile
 * and no generation holds it.
 */
async function applyChange(prisma, item, data) {
  if (claimIsLive(item)) throw generationInProgress();
  const { count } = await prisma.pipelineItem.updateMany({
    where: { id: item.id, revision: item.revision, stage: item.stage, ...noLiveClaim() },
    data,
  });
  if (count !== 1) {
    const current = await prisma.pipelineItem.findUnique({ where: { id: item.id } });
    if (current && claimIsLive(current)) throw generationInProgress();
    throw new ApiError("REVISION_CONFLICT", 409, "The item changed while this request was processed; reload and retry");
  }
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
  const items = await req.prisma.pipelineItem.findMany({ where, orderBy: { createdAt: "desc" }, include: ITEM_INCLUDE, take: listLimit(req) });
  res.json(items.map(serializeItem));
}));

// ─── TRENDS (before /:id) ────────────────────────────────────

router.get("/trends", handle("GET /pipeline/trends", async (req, res) => {
  const where = {};
  if (typeof req.query.platform === "string") where.platform = req.query.platform;
  if (typeof req.query.status === "string") where.status = req.query.status;
  const trends = await req.prisma.trend.findMany({
    take: listLimit(req),
    where,
    orderBy: { createdAt: "desc" },
    include: { scripts: { select: { id: true, title: true, status: true } } },
  });
  res.json(trends);
}));

router.get("/scripts", handle("GET /pipeline/scripts", async (req, res) => {
  const where = {};
  if (typeof req.query.status === "string") where.status = req.query.status;
  if (typeof req.query.character_id === "string") where.characterId = req.query.character_id;
  const scripts = await req.prisma.script.findMany({
    take: listLimit(req),
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
router.post("/discover-trends", ["edit"], handle("POST /pipeline/discover-trends", async (req, res) => {
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
        // WHY null: fixture scores were random numbers, not observations.
        trendScore: null,
        kind: "simulated_fixture",
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

router.post("/generate-script", ["edit"], handle("POST /pipeline/generate-script", async (req, res) => {
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
  // Pin the character version the script was written for; later edits or
  // versions of the character never change this item's inputs.
  const version = await ensurePublishedVersion(req.prisma, character, { by: req.principal?.id });
  // Version 1 of the script, with its shot plan; the item pins it.
  const { version: scriptVersion } = await req.prisma.$transaction((tx) =>
    createScriptVersion(tx, script, initialScriptInput(scriptData), { characterVersion: version, by: req.principal?.id }));
  const pipelineItem = await req.prisma.pipelineItem.create({
    data: {
      stage: "draft", scriptId: script.id, characterId, platform: null, characterVersionId: version.id,
      scriptVersionId: scriptVersion.id, disclosure: DEFAULT_DISCLOSURE, exportSettings: DEFAULT_EXPORT_SETTINGS,
    },
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
 * Lifecycle (WHY each step exists):
 *  1. Preflight every stage: a blocked stage fails before any write or spend.
 *  2. Claim the item at its current revision with a fresh token, BEFORE any
 *     reservation: competing requests (other keys), schedules, approvals and
 *     edits are refused while the claim is live, so nothing interleaves with
 *     the slow provider call.
 *  3. Run the workflow; its total cost is reserved up front.
 *  4. Apply each result in one transaction that requires our token, the
 *     expected revision and a not-scheduled stage, and that records a
 *     generation_applications row. A result whose fence fails is recorded in
 *     the ledger but never written over newer state.
 *  5. Replays: a result already applied is returned as recorded and changes
 *     nothing (so an old key cannot bring back old media or clear a later
 *     approval). A result recorded but never applied is recovered only when
 *     no other workflow has started on the item since.
 *  6. Release the claim; keep the workflow key on failure so a retry resumes.
 */
router.post("/generate-content", ["generate", "spend"], handle("POST /pipeline/generate-content", async (req, res) => {
  const { pipelineItemId, type = "image", referenceMode = "none", shotIndex, confirmReplaceApproved } = req.body || {};
  if (shotIndex !== undefined && (!Number.isInteger(shotIndex) || shotIndex < 0 || shotIndex > 99)) throw invalid("shotIndex must be a whole number");
  if (!pipelineItemId || typeof pipelineItemId !== "string") throw invalid("pipelineItemId is required");
  if (!["image", "video"].includes(type)) throw invalid(`Unsupported content type: ${String(type).slice(0, 20)}`);
  // "required": the pinned references must actually be sent to the provider.
  if (!["none", "required"].includes(referenceMode)) throw invalid("referenceMode must be none or required");
  const clientKey = readIdempotencyKey(req);
  const gate = req.generationGate;
  const prisma = req.prisma;

  const item = await prisma.pipelineItem.findUnique({
    where: { id: pipelineItemId },
    include: { character: true, script: true },
  });
  if (!item) throw notFound();
  assertNotScheduled(item);
  if (claimIsLive(item)) throw generationInProgress();
  // WHY: regenerating approved content discards that approval; it must be a
  // deliberate choice, never a side effect of a stray click or retry.
  if (item.stage === "approved" && confirmReplaceApproved !== true) {
    throw new ApiError("APPROVED_CONTENT", 409, "This item is approved; regenerating clears the approval. Send confirmReplaceApproved: true to proceed");
  }

  const needsImage = type === "image" || !item.imageUrl;
  const kinds = type === "image" ? ["image"] : needsImage ? ["image", "video"] : ["video"];
  // (1) Blocks before ANY write, reservation or provider call if any stage is not permitted.
  const checks = gate.preflightAll(kinds);

  // The pinned version, or (legacy items) the published one, pinned on apply.
  const version = item.characterVersionId
    ? await prisma.characterVersion.findUnique({ where: { id: item.characterVersionId } })
    : await ensurePublishedVersion(prisma, item.character, { by: req.principal?.id });
  if (!version) throw new ApiError("VERSION_MISSING", 409, "The character version this item is pinned to no longer exists");

  // Reference conditioning is checked before any claim or spend.
  // WHY: a stored reference proves nothing if it is never sent, and a
  // reference may only be sent once its rights allow it.
  let referencesSent = [];
  let references = [];
  if (referenceMode === "required") {
    if (!gate.capabilities("image")?.referenceConditioning) {
      throw new ApiError("REFERENCE_CONDITIONING_UNSUPPORTED", 409,
        "The selected image provider does not send reference images, so identity conditioning is not possible");
    }
    const pinned = Array.isArray(version.references) ? version.references : [];
    if (!pinned.length) throw new ApiError("REFERENCE_NOT_CLEARED", 409, "This character version has no reference images pinned");
    const blocked = [];
    for (const ref of pinned) {
      const c = await clearanceFor(prisma, ref.imageId, "provider_input");
      if (!c.cleared) blocked.push({ imageId: ref.imageId, missing: c.missing });
    }
    if (blocked.length) {
      throw new ApiError("REFERENCE_NOT_CLEARED", 409, "Reference images may not be sent to a provider yet", { blocked });
    }
    const images = await prisma.characterImage.findMany({ where: { id: { in: pinned.map((r) => r.imageId) } } });
    references = images.map((img) => ({ url: img.imageUrl, fingerprint: img.fingerprint }));
    referencesSent = references.map((r) => r.fingerprint);
  }

  // A single shot of the package (its media goes into shotMedia, not the
  // item's primary image/video).
  let shot = null;
  if (shotIndex !== undefined) {
    const sv = item.scriptVersionId ? await prisma.scriptVersion.findUnique({ where: { id: item.scriptVersionId } }) : null;
    if (!sv) throw new ApiError("NO_SHOT_PLAN", 409, "This item has no script version with a shot plan");
    shot = sv.shotPlan[shotIndex];
    if (!shot) throw invalid(`shotIndex ${shotIndex} is not in the shot plan (${sv.shotPlan.length} shots)`);
    if (type !== "video") throw invalid("Shots are generated as video clips (type: video)");
  }
  const tag = shot ? `${type}#${shotIndex}` : type;
  const hash = requestHash({ op: "pipeline.generate-content", pipelineItemId, type, referenceMode, shotIndex: shotIndex ?? null });
  const resumable = item.activeWorkflowKey?.startsWith(`${tag}|`) ? item.activeWorkflowKey : null;
  const workflowKey = clientKey
    ? `${tag}|client:${clientKey}`
    : resumable || `${tag}|pipe:${item.id}:r${item.revision}`;
  // Captured before the claim overwrites it: an unapplied result may only be
  // recovered if this same workflow was the last one started on the item.
  const priorWorkflowKey = item.activeWorkflowKey;

  // (2) Atomic claim. The revision condition makes it fail if anything changed
  // since the read above; the claim condition makes competing requests fail.
  const token = crypto.randomUUID();
  const claimed = await prisma.pipelineItem.updateMany({
    where: { id: item.id, revision: item.revision, stage: { not: "scheduled" }, ...noLiveClaim() },
    data: { generationClaim: token, generationClaimedAt: new Date(), activeWorkflowKey: workflowKey },
  });
  if (claimed.count !== 1) {
    const current = await prisma.pipelineItem.findUnique({ where: { id: item.id } });
    if (current?.stage === "scheduled") assertNotScheduled(current);
    if (current && claimIsLive(current)) throw generationInProgress();
    throw new ApiError("REVISION_CONFLICT", 409, "The item changed while this request was processed; reload and retry");
  }

  // From the pinned version, never the live draft.
  const prompt = buildPromptFromCharacter(promptSourceOf(version));
  const motionPrompt = shot
    ? `${shot.scene}. ${shot.visualAction}. Says: "${shot.dialogue}"`.slice(0, 500)
    : item.script
      ? `${item.script.hook || ""} ${item.script.body || ""}`.trim().slice(0, 500)
      : "Subtle natural movement, gentle head turn, cinematic lighting";
  // Clip length requested from the provider; the shot's own length decides how much is used.
  const clipSeconds = shot ? (shot.durationSec <= 5 ? 5 : 10) : 5;

  let expectedRevision = item.revision;
  const outcomes = [];
  let journal = null;
  const stepIndexOf = (kind) => kinds.indexOf(kind);

  // (4)/(5) Fenced, recorded application of one step's result.
  async function applyResult(kind, r, fields) {
    const mediaUrl = kind === "image" ? r.imageUrl : r.videoUrl;
    const recorded = { kind, mediaUrl: mediaUrl || null, reservationId: r.reservationId || null, replayed: r.replayed === true };

    if (r.replayed) {
      const applied = r.reservationId
        ? await prisma.generationApplication.findUnique({ where: { reservationId: r.reservationId } })
        : null;
      if (applied) {
        // Already applied once: return what was recorded, change nothing.
        outcomes.push({ ...recorded, applied: false, alreadyApplied: true });
        return;
      }
      if (priorWorkflowKey !== workflowKey) {
        // Recorded but never applied, and another workflow has run since:
        // applying it now would overwrite newer media.
        throw new ApiError("GENERATION_SUPERSEDED", 409,
          "This result was recorded but never applied, and the item has newer generation work; it was not applied",
          { reservationId: r.reservationId, result: { [kind === "image" ? "imageUrl" : "videoUrl"]: mediaUrl } });
      }
    }
    if (!mediaUrl) throw new Error(`${kind} result has no media URL`);
    // WHY: provider output is stored and shown/exported later; a non-public
    // or non-https URL is refused (recorded in the ledger, not applied).
    if (!checkExternalUrl(mediaUrl).ok) {
      throw new ApiError("UNSAFE_MEDIA_URL", 502, "The provider returned a media URL that is not a public https URL; it was not applied",
        { reservationId: r.reservationId });
    }

    await gate.fault("beforeApply");
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.pipelineItem.updateMany({
        where: { id: item.id, generationClaim: token, revision: expectedRevision, stage: { not: "scheduled" } },
        data: invalidatingChange({ ...(await fields(mediaUrl, tx, r)), characterVersionId: version.id }, "content_generated"),
      });
      if (count !== 1) {
        throw new ApiError("GENERATION_SUPERSEDED", 409,
          "The item changed or this generation lost its claim; the result was recorded but not applied",
          { reservationId: r.reservationId, result: { [kind === "image" ? "imageUrl" : "videoUrl"]: mediaUrl } });
      }
      await tx.generationApplication.create({
        data: {
          reservationId: r.reservationId, pipelineItemId: item.id, kind, mediaUrl, revision: expectedRevision + 1,
          // Actual inputs: what was really sent, not what was stored.
          characterVersionId: version.id,
          promptHash: promptHash(kind === "image" ? prompt : motionPrompt),
          referencesSent: kind === "image" ? referencesSent : [],
          conditioning: kind === "image" && referencesSent.length ? "references_sent" : "none",
        },
      });
    });
    expectedRevision += 1;
    await journal?.markApplied(stepIndexOf(kind)).catch((e) => console.error("journal markApplied failed:", e?.message));
    outcomes.push({ ...recorded, applied: true, recovered: r.replayed === true });
  }

  const steps = [];
  if (needsImage) {
    steps.push({
      kind: "image",
      idempotencyKey: `${workflowKey}:image`,
      requestHash: hash,
      input: {
        prompt,
        options: { aspectRatio: version.styling?.aspectRatio || "9:16" },
        ...(references.length ? { references } : {}),
      },
      // A new still invalidates any video made from the old one, and any approval.
      onResult: (r) => applyResult("image", r, (url) => ({ imageUrl: url, videoUrl: null })),
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
        options: { duration: String(clipSeconds), mode: "std" },
      }),
      onResult: (r) => applyResult("video", r, shot
        ? async (url, tx, res) => {
          // Replace this shot's clip; keep the others. durationSource says
          // whether the length was reported by the provider or only requested.
          const cur = await tx.pipelineItem.findUnique({ where: { id: item.id }, select: { shotMedia: true } });
          const others = (cur?.shotMedia || []).filter((m) => m.shotIndex !== shotIndex);
          const reported = Number.isFinite(res.durationSec) && res.durationSec > 0;
          return {
            shotMedia: [...others, {
              shotIndex, shotKey: shot.shotKey, kind: "video", url,
              durationSec: reported ? res.durationSec : clipSeconds,
              durationSource: reported ? "provider_reported" : "declared",
              reservationId: res.reservationId || null,
            }].sort((a, b) => a.shotIndex - b.shotIndex),
          };
        }
        : (url) => ({ videoUrl: url })),
    });
  }

  // (3)/(6)
  let finished = false;
  let died = false;
  let failureCode = null;
  let keepWorkflowKey = workflowKey; // on failure: a retry resumes this workflow
  try {
    // Durable job journal: written before each irreversible step.
    journal = await createJob(prisma, {
      kind: "pipeline.generate-content", targetType: "pipeline_item", targetId: item.id, workflowKey, requestHash: hash,
      steps: steps.map((st, i) => ({ kind: st.kind, provider: checks[i].provider, model: checks[i].model, idempotencyKey: st.idempotencyKey })),
      by: req.principal?.id,
    });
    await gate.runWorkflow(steps, { hooks: journal.hooks });
    finished = true;
  } catch (err) {
    // A (simulated) process death leaves everything exactly as it was.
    if (isProcessDeath(err)) { died = true; throw err; }
    failureCode = err instanceof ApiError ? err.code : "INTERNAL_ERROR";
    // A superseded result must not become recoverable later: put back the
    // workflow key that was current before this request.
    if (err instanceof ApiError && err.code === "GENERATION_SUPERSEDED") keepWorkflowKey = priorWorkflowKey;
    throw err;
  } finally {
    if (!died) {
    await journal?.finish(failureCode).catch((e) => console.error("journal finish failed:", e?.message));
    // Only our own claim is released (a taken-over or cleared claim is left alone).
    await prisma.pipelineItem.updateMany({
      where: { id: item.id, generationClaim: token },
      data: { generationClaim: null, generationClaimedAt: null, activeWorkflowKey: finished ? null : keepWorkflowKey },
    }).catch((e) => console.error("generate-content: claim release failed:", e?.message));
    }
  }

  const updated = await prisma.pipelineItem.findUnique({ where: { id: item.id }, include: ITEM_INCLUDE });
  res.json({
    success: true,
    type,
    pipelineItem: serializeItem(updated),
    imageUrl: updated.imageUrl,
    videoUrl: updated.videoUrl,
    replayed: outcomes.length > 0 && outcomes.every((o) => o.replayed),
    results: outcomes,
    jobId: journal?.jobId || null,
  });
}));

// ─── CAPTION / MANUAL EDITS ──────────────────────────────────

router.post("/generate-caption", ["edit"], handle("POST /pipeline/generate-caption", async (req, res) => {
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

// PATCH /api/pipeline/:id { caption?, hashtags?, platform?, disclosure?, exportSettings?, schedule?, revision? }
// Any change bumps the revision and invalidates an existing approval.
router.patch("/:id", ["edit"], handle("PATCH /pipeline/:id", async (req, res) => {
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
  if (body.disclosure !== undefined) {
    if (body.disclosure !== null && (typeof body.disclosure !== "string" || body.disclosure.length > 500)) throw invalid("disclosure must be text of at most 500 characters");
    changes.disclosure = body.disclosure;
  }
  if (body.exportSettings !== undefined) {
    const e = body.exportSettings;
    if (!e || typeof e !== "object" || !["mp4", "mov"].includes(e.format) || !["9:16", "1:1", "16:9"].includes(e.aspectRatio) || typeof e.burnInCaptions !== "boolean") {
      throw invalid("exportSettings must be { format: mp4|mov, aspectRatio: 9:16|1:1|16:9, burnInCaptions: boolean }");
    }
    changes.exportSettings = { format: e.format, aspectRatio: e.aspectRatio, burnInCaptions: e.burnInCaptions };
  }
  if (body.schedule !== undefined) Object.assign(changes, parseSchedule(body.schedule));
  if (body.crossPostDestinations !== undefined) {
    const list = body.crossPostDestinations;
    if (!Array.isArray(list) || list.some((d) => !DESTINATIONS.includes(d)) || new Set(list).size !== list.length) {
      throw invalid(`crossPostDestinations must be a list of distinct destinations from ${DESTINATIONS.join(", ")}`);
    }
    changes.crossPostDestinations = [...list].sort();
  }
  if (body.revision !== undefined && !Number.isInteger(body.revision)) throw invalid("revision must be an integer");

  const item = await req.prisma.pipelineItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw notFound();
  if (body.revision !== undefined && body.revision !== item.revision) {
    throw new ApiError("REVISION_CONFLICT", 409, `Item is at revision ${item.revision}, not ${body.revision}`);
  }
  assertNotScheduled(item);

  const same = (a, b) => JSON.stringify(a instanceof Date ? a.toISOString() : a ?? null) === JSON.stringify(b instanceof Date ? b.toISOString() : b ?? null);
  const changed = Object.fromEntries(Object.entries(changes).filter(([k, v]) => !same(item[k], v)));
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

router.delete("/:id", ["edit"], handle("DELETE /pipeline/:id", async (req, res) => {
  const item = await req.prisma.pipelineItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw notFound();
  if (item.stage === "scheduled") throw new ApiError("ALREADY_SCHEDULED", 409, "Cancel the schedule before deleting this item");
  if (item.stage === "published") throw new ApiError("ALREADY_PUBLISHED", 409, "Published items are kept as the record of what was posted");
  await req.prisma.pipelineItem.delete({ where: { id: req.params.id } });
  res.json({ success: true });
}));

// ─── APPROVAL WORKFLOW ───────────────────────────────────────

// POST /api/pipeline/:id/approve { revision, snapshotHash, notes? }
// Approves exactly the snapshot the reviewer saw.
router.post("/:id/approve", ["approve"], handle("POST /pipeline/:id/approve", async (req, res) => {
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
  if (!mediaTypeOf(item) && !(item.shotMedia || []).length) throw new ApiError("MEDIA_REQUIRED", 409, "Generate media before approval");
  // WHY: the synthetic persona must be disclosed in what gets exported, not
  // only in a footer; and no invented fact may be approved as real.
  if (!item.disclosure || !item.disclosure.trim()) throw new ApiError("DISCLOSURE_REQUIRED", 409, "Add the synthetic-persona disclosure before approval");
  const sv = item.scriptVersionId ? await req.prisma.scriptVersion.findUnique({ where: { id: item.scriptVersionId } }) : null;
  if (sv) {
    const claims = checkClaims(sv, sv.evidence || [], item.disclosure);
    if (!claims.ok) {
      throw new ApiError("CLAIMS_UNSUPPORTED", 409, "Some lines read as facts or real experience without a source or fiction framing",
        { unsupported: claims.unsupported });
    }
    // A multi-shot package must be complete, within the duration tolerance,
    // and measured (reported by the media source, not just requested).
    if ((item.shotMedia || []).length) {
      const m = measurePackage(sv.shotPlan, item.shotMedia, sv.targetDurationSec);
      if (!m.complete || !m.check.withinTolerance || !m.verified) {
        throw new ApiError("PACKAGE_INCOMPLETE", 409,
          "Every shot needs a clip covering its planned length, with a reported (not just requested) duration, within tolerance",
          { measuredSec: m.measuredSec, check: m.check, verified: m.verified, perShot: m.perShot });
      }
    }
  }
  // WHY: approving media that a running generation is about to replace would
  // approve something nobody will see.
  if (claimIsLive(item)) throw generationInProgress();

  const { count } = await req.prisma.pipelineItem.updateMany({
    where: { id: item.id, revision: item.revision, stage: "review", ...noLiveClaim() },
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

router.post("/:id/reject", ["approve"], handle("POST /pipeline/:id/reject", async (req, res) => {
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

// POST /api/pipeline/:id/schedule { platform? }
// Puts the approved snapshot on the calendar at the approved instant. The
// instant and zone are part of the approval, so there is nothing to choose
// here: to change the time, edit the item (which clears approval) and
// re-approve. Calendar planning only; nothing is published. Atomic and
// idempotent per approved snapshot (unique scheduleKey).
router.post("/:id/schedule", ["schedule"], handle("POST /pipeline/:id/schedule", async (req, res) => {
  const { scheduledDate, platform } = req.body || {};
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
      if (!item.scheduledAt || !item.scheduleTimezone) {
        throw new ApiError("SCHEDULE_TIME_REQUIRED", 409,
          "Set the destination time and time zone on the item, then approve it; the approval covers the schedule");
      }
      if (scheduledDate !== undefined && scheduledDate !== item.scheduledDate) {
        throw new ApiError("SCHEDULE_NOT_APPROVED", 409,
          `The approved schedule is ${item.scheduleLocal} ${item.scheduleTimezone}; a different date needs a new approval`);
      }
      if (platform !== undefined && platform !== item.platform) {
        throw new ApiError("DESTINATION_MISMATCH", 409,
          `Approved destination is ${item.platform}; scheduling elsewhere requires a new approval`);
      }
      if (new Date(item.scheduledAt).getTime() <= Date.now()) {
        throw new ApiError("SCHEDULE_IN_PAST", 409, "The approved time has already passed; choose a new time and re-approve");
      }
      // WHY: a running generation will replace this item's media; scheduling
      // now would put media on the calendar that is about to change.
      if (claimIsLive(item)) throw generationInProgress();

      // Claim: only one concurrent request can move approved -> scheduled.
      const claim = await tx.pipelineItem.updateMany({
        where: { id: item.id, stage: "approved", revision: item.revision, approvedHash: hash, ...noLiveClaim() },
        // Clearing an abandoned claim fences out its late result (token gone).
        data: { stage: "scheduled", generationClaim: null, generationClaimedAt: null },
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
          scheduledDate: item.scheduledDate,
          scheduledAt: item.scheduledAt,
          scheduleTimezone: item.scheduleTimezone,
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

// POST /api/pipeline/:id/cancel-schedule { reason }
// WHY fencing: the calendar entry is marked cancelled (never deliverable) in
// the same transaction that moves the item back to review with a new
// revision. Any downstream job holding the old snapshot then fails its
// conditional checks (status, approved hash) instead of delivering it.
router.post("/:id/cancel-schedule", ["schedule"], handle("POST /pipeline/:id/cancel-schedule", async (req, res) => {
  const reason = req.body?.reason;
  if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500) {
    throw invalid("reason is required (3-500 characters)");
  }
  const prisma = req.prisma;
  const item = await prisma.pipelineItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw notFound();
  if (item.stage !== "scheduled") throw new ApiError("INVALID_TRANSITION", 409, `Only scheduled items can be cancelled (current stage: ${item.stage})`);
  await prisma.$transaction(async (tx) => {
    const moved = await tx.pipelineItem.updateMany({
      where: { id: item.id, stage: "scheduled", revision: item.revision },
      data: invalidatingChange({ generationClaim: null, generationClaimedAt: null }, "review"),
    });
    if (moved.count !== 1) throw new ApiError("REVISION_CONFLICT", 409, "The item changed meanwhile; reload and retry");
    if (item.contentId) {
      const stamp = { cancelledAt: new Date(), cancelledBy: req.principal?.role || "unknown", cancelReason: reason.trim() };
      await tx.content.updateMany({ where: { id: item.contentId, status: "scheduled", cancelledAt: null }, data: { status: "cancelled", ...stamp } });
      // Partly published: what is out stays out (and stays recorded); the
      // remaining destinations are stopped.
      await tx.content.updateMany({ where: { id: item.contentId, status: "partially_published", cancelledAt: null }, data: stamp });
      await tx.publishDelivery.updateMany({
        where: { job: { contentId: item.contentId }, state: { in: ["pending", "failed", "resolved_not_published"] } },
        data: { state: "cancelled" },
      });
    }
  });
  const job = item.contentId ? await prisma.publishJob.findUnique({ where: { contentId: item.contentId } }) : null;
  if (job) await settleJob(prisma, job.id);
  const updated = await prisma.pipelineItem.findUnique({ where: { id: item.id }, include: ITEM_INCLUDE });
  const content = item.contentId ? await prisma.content.findUnique({ where: { id: item.contentId } }) : null;
  res.json({ success: true, pipelineItem: serializeItem(updated), content });
}));

export default router;
