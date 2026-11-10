import { secureRouter } from "../lib/secureRouter.js";
import { ApiError, routeError } from "../lib/errors.js";
import { checkExternalUrl } from "../lib/urlSafety.js";
import { listLimit } from "../lib/validate.js";
import { serializeItem, DESTINATIONS } from "../lib/revision.js";
import { validateScriptInput, createScriptVersion, repinItems } from "../services/scriptVersions.js";
import { measurePackage, checkDuration } from "../services/shotPlan.js";
import { checkClaims } from "../services/claims.js";
import { claimIsLive } from "./pipeline.js";

/**
 * Ideas, script versions and the content package view (Package C).
 * Mounted under /api/pipeline before the pipeline router.
 */
const router = secureRouter();
const invalid = (msg, details) => new ApiError("VALIDATION_FAILED", 400, msg, details);
const wrap = (label, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { routeError(res, err, `Failed: ${label}`, label); }
};

// ─── Ideas: manual or sourced, never invented trends ─────────

// POST /api/pipeline/ideas { topic, description?, platform? } — an operator's own idea
router.post("/ideas", ["edit"], wrap("POST /pipeline/ideas", async (req, res) => {
  const { topic, description, platform } = req.body || {};
  if (typeof topic !== "string" || topic.trim().length < 3 || topic.length > 200) throw invalid("topic is required (3-200 characters)");
  if (description !== undefined && (typeof description !== "string" || description.length > 2000)) throw invalid("description must be at most 2000 characters");
  if (platform !== undefined && !DESTINATIONS.includes(platform)) throw invalid(`platform must be one of ${DESTINATIONS.join(", ")}`);
  const idea = await req.prisma.trend.create({
    data: {
      kind: "manual_idea", provenance: "manual", topic: topic.trim(), description: description || null,
      platform: platform || "unspecified", trendScore: null, hashtags: [], status: "new", recordedBy: req.principal.id,
    },
  });
  res.status(201).json(idea);
}));

// POST /api/pipeline/observations { topic, platform, sourceUrl, observedAt, observation }
// WHY all required: an observation without where, when and what exactly was
// seen cannot be checked, so it is not accepted as one.
router.post("/observations", ["edit"], wrap("POST /pipeline/observations", async (req, res) => {
  const { topic, platform, sourceUrl, observedAt, observation, description } = req.body || {};
  const fields = {};
  if (typeof topic !== "string" || topic.trim().length < 3 || topic.length > 200) fields.topic = "is required (3-200 characters)";
  if (!DESTINATIONS.includes(platform)) fields.platform = `must be one of ${DESTINATIONS.join(", ")}`;
  const url = typeof sourceUrl === "string" ? checkExternalUrl(sourceUrl) : { ok: false, reason: "is required" };
  if (!url.ok) fields.sourceUrl = url.reason;
  const when = new Date(observedAt);
  if (!observedAt || Number.isNaN(when.getTime())) fields.observedAt = "is required (ISO date-time)";
  else if (when.getTime() > Date.now() + 60_000) fields.observedAt = "cannot be in the future";
  if (typeof observation !== "string" || observation.trim().length < 3 || observation.length > 1000) fields.observation = "is required: the exact thing seen (3-1000 characters)";
  if (Object.keys(fields).length) throw invalid("Observation is incomplete", { fields });
  const row = await req.prisma.trend.create({
    data: {
      kind: "observation", provenance: "verified_source", topic: topic.trim(), platform,
      sourceUrl, source: sourceUrl, observedAt: when, observation: observation.trim(),
      description: typeof description === "string" ? description.slice(0, 2000) : null,
      trendScore: null, hashtags: [], status: "new", recordedBy: req.principal.id,
    },
  });
  res.status(201).json(row);
}));

// ─── Script versions ─────────────────────────────────────────

router.get("/scripts/:id/versions", wrap("GET /pipeline/scripts/:id/versions", async (req, res) => {
  const script = await req.prisma.script.findUnique({ where: { id: req.params.id } });
  if (!script) throw new ApiError("NOT_FOUND", 404, "Script not found");
  const versions = await req.prisma.scriptVersion.findMany({ where: { scriptId: script.id }, orderBy: { version: "desc" }, take: listLimit(req) });
  res.json({ currentVersion: script.currentVersion, versions });
}));

// PUT /api/pipeline/scripts/:id { expectedVersion, hook?, body?, callToAction?, speakingPaceWpm?, targetDurationSec?, evidence? }
router.put("/scripts/:id", ["edit"], wrap("PUT /pipeline/scripts/:id", async (req, res) => {
  const { expectedVersion } = req.body || {};
  if (!Number.isInteger(expectedVersion)) throw invalid("expectedVersion (the version you edited) is required");
  const result = await req.prisma.$transaction(async (tx) => {
    const script = await tx.script.findUnique({ where: { id: req.params.id } });
    if (!script) throw new ApiError("NOT_FOUND", 404, "Script not found");
    // WHY: two people editing the same version must not silently overwrite each other.
    if (script.currentVersion !== expectedVersion) {
      throw new ApiError("SCRIPT_VERSION_CONFLICT", 409, `The script is at version ${script.currentVersion}; reload and reapply your edit`);
    }
    const current = await tx.scriptVersion.findFirst({ where: { scriptId: script.id }, orderBy: { version: "desc" } });
    const input = validateScriptInput(req.body, current || {});
    // The shot plan uses the character version the current script version used.
    const characterVersion = current?.characterVersionId
      ? await tx.characterVersion.findUnique({ where: { id: current.characterVersionId } })
      : null;
    const { version, unchanged } = await createScriptVersion(tx, script, input, { characterVersion, by: req.principal.id });
    const moved = unchanged ? 0 : await repinItems(tx, script.id, version, { isLive: (i) => claimIsLive(i) });
    return { version, unchanged, itemsMoved: moved };
  });
  res.status(result.unchanged ? 200 : 201).json(result);
}));

// ─── Content package view ────────────────────────────────────

// GET /api/pipeline/:id/package — everything the reviewer sees, read from the server
router.get("/:id/package", wrap("GET /pipeline/:id/package", async (req, res) => {
  const item = await req.prisma.pipelineItem.findUnique({
    where: { id: req.params.id },
    include: { character: { select: { id: true, name: true, characterId: true } }, content: true },
  });
  if (!item) throw new ApiError("NOT_FOUND", 404, "Pipeline item not found");
  const scriptVersion = item.scriptVersionId ? await req.prisma.scriptVersion.findUnique({ where: { id: item.scriptVersionId } }) : null;
  const characterVersion = item.characterVersionId
    ? await req.prisma.characterVersion.findUnique({ where: { id: item.characterVersionId }, select: { id: true, version: true, contentHash: true, references: true } })
    : null;
  const shots = scriptVersion?.shotPlan || [];
  const media = measurePackage(shots, item.shotMedia, scriptVersion?.targetDurationSec || 0);
  const storyboard = shots.map((s) => ({ ...s, media: (item.shotMedia || []).find((m) => m.shotIndex === s.index) || null, mediaStatus: media.perShot[s.index] }));
  res.json({
    item: serializeItem(item),
    characterVersion,
    script: scriptVersion && {
      id: scriptVersion.scriptId, version: scriptVersion.version, hook: scriptVersion.hook, body: scriptVersion.body,
      callToAction: scriptVersion.callToAction, speakingPaceWpm: scriptVersion.speakingPaceWpm,
      targetDurationSec: scriptVersion.targetDurationSec, evidence: scriptVersion.evidence,
    },
    storyboard,
    duration: scriptVersion && {
      planned: checkDuration(scriptVersion.targetDurationSec, scriptVersion.plannedDurationSec),
      measured: { ...media.check, complete: media.complete, verified: media.verified },
    },
    claims: scriptVersion ? checkClaims(scriptVersion, scriptVersion.evidence || [], item.disclosure) : null,
    disclosure: item.disclosure,
    destination: item.platform,
    exportSettings: item.exportSettings,
    caption: item.caption,
    hashtags: item.hashtags,
  });
}));

export default router;
