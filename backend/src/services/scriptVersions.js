import crypto from "crypto";
import { ApiError } from "../lib/errors.js";
import { checkExternalUrl } from "../lib/urlSafety.js";
import { stableStringify } from "./spendLedger.js";
import { planShots, parseDurationSec, DEFAULT_PACE_WPM } from "./shotPlan.js";
import { invalidatingChange } from "../lib/revision.js";

/**
 * Script versions.
 *
 * WHY: generated text is a first draft. People edit it, and an edit must be
 * kept as history and must not silently change content that was already
 * approved. Each edit creates an immutable ScriptVersion (with its shot plan);
 * unscheduled items using the script move to the new version, which bumps
 * their revision and clears any approval. Scheduled items keep the version
 * they were approved with.
 */
export const DEFAULT_DISCLOSURE = "This is a fictional, AI-generated character.";
export const DEFAULT_EXPORT_SETTINGS = Object.freeze({ format: "mp4", aspectRatio: "9:16", burnInCaptions: true });

const invalid = (fields) => new ApiError("VALIDATION_FAILED", 400, "Some fields are invalid", { fields });

/** Validates editable script fields; returns normalised values. */
export function validateScriptInput(body, current = {}) {
  const b = body || {};
  const fields = {};
  const out = {};
  for (const k of ["hook", "body", "callToAction"]) {
    const v = b[k] === undefined ? current[k] ?? null : b[k];
    if (v !== null && (typeof v !== "string" || v.length > 5000)) fields[k] = "must be text of at most 5000 characters";
    out[k] = v;
  }
  const pace = b.speakingPaceWpm ?? current.speakingPaceWpm ?? DEFAULT_PACE_WPM;
  if (!Number.isInteger(pace) || pace < 80 || pace > 240) fields.speakingPaceWpm = "must be a whole number from 80 to 240 words per minute";
  out.speakingPaceWpm = pace;
  const target = b.targetDurationSec ?? current.targetDurationSec ?? 30;
  if (!Number.isInteger(target) || target < 5 || target > 180) fields.targetDurationSec = "must be a whole number of seconds from 5 to 180";
  out.targetDurationSec = target;
  const evidence = b.evidence ?? current.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > 50) fields.evidence = "must be a list of at most 50 entries";
  else {
    evidence.forEach((e, i) => {
      if (!e || typeof e.claim !== "string" || e.claim.trim().length < 3 || e.claim.length > 500) fields[`evidence[${i}].claim`] = "is required (3-500 characters)";
      if (!["source", "fictional"].includes(e?.basis)) fields[`evidence[${i}].basis`] = "must be source or fictional";
      if (e?.basis === "source") {
        const c = typeof e.sourceUrl === "string" ? checkExternalUrl(e.sourceUrl) : { ok: false, reason: "is required for a sourced claim" };
        if (!c.ok) fields[`evidence[${i}].sourceUrl`] = c.reason;
        if (e.observedAt !== undefined && Number.isNaN(new Date(e.observedAt).getTime())) fields[`evidence[${i}].observedAt`] = "must be an ISO date-time";
      }
    });
  }
  out.evidence = Array.isArray(evidence)
    ? evidence.map((e) => ({ claim: e.claim?.trim(), basis: e.basis, ...(e.sourceUrl ? { sourceUrl: e.sourceUrl } : {}), ...(e.observedAt ? { observedAt: e.observedAt } : {}) }))
    : [];
  if (Object.keys(fields).length) throw invalid(fields);
  return out;
}

/** Creates the next immutable version and mirrors it onto the Script row. */
export async function createScriptVersion(tx, script, input, { characterVersion, by }) {
  const plan = planShots({ ...input, characterVersion });
  const contentHash = crypto.createHash("sha256").update(stableStringify({ ...input, characterVersionId: characterVersion?.id || null })).digest("hex");
  const latest = await tx.scriptVersion.findFirst({ where: { scriptId: script.id }, orderBy: { version: "desc" } });
  if (latest && latest.contentHash === contentHash) return { version: latest, unchanged: true };
  const version = await tx.scriptVersion.create({
    data: {
      scriptId: script.id, version: (latest?.version || 0) + 1,
      hook: input.hook, body: input.body, callToAction: input.callToAction,
      speakingPaceWpm: input.speakingPaceWpm, targetDurationSec: input.targetDurationSec, evidence: input.evidence,
      shotPlan: plan.shots, plannedDurationSec: plan.plannedDurationSec,
      characterVersionId: characterVersion?.id || null, contentHash, createdBy: by || null,
    },
  });
  await tx.script.update({
    where: { id: script.id },
    data: { hook: input.hook, body: input.body, callToAction: input.callToAction, duration: `${input.targetDurationSec}s`, currentVersion: version.version },
  });
  return { version, unchanged: false };
}

/** First version for a freshly generated script. */
export function initialScriptInput(scriptData) {
  return {
    hook: scriptData.hook ?? null, body: scriptData.body ?? null, callToAction: scriptData.callToAction ?? null,
    speakingPaceWpm: DEFAULT_PACE_WPM, targetDurationSec: parseDurationSec(scriptData.duration) || 30, evidence: [],
  };
}

/**
 * Moves unscheduled items of this script to the new version. Shot media is
 * kept only for shots whose content (dialogue, action, scene) is unchanged.
 */
export async function repinItems(tx, scriptId, version, { isLive }) {
  const items = await tx.pipelineItem.findMany({ where: { scriptId, stage: { not: "scheduled" } } });
  if (items.some((i) => isLive(i))) {
    throw new ApiError("GENERATION_IN_PROGRESS", 409, "A generation for an item using this script is in progress; wait for it to finish");
  }
  const keys = new Map(version.shotPlan.map((s) => [s.index, s.shotKey]));
  let moved = 0;
  for (const item of items) {
    if (item.scriptVersionId === version.id) continue;
    const kept = (item.shotMedia || []).filter((m) => keys.get(m.shotIndex) === m.shotKey);
    const { count } = await tx.pipelineItem.updateMany({
      where: { id: item.id, revision: item.revision },
      data: invalidatingChange({ scriptVersionId: version.id, shotMedia: kept }, item.stage === "approved" ? "review" : undefined),
    });
    if (count !== 1) throw new ApiError("REVISION_CONFLICT", 409, "An item using this script changed meanwhile; reload and retry");
    moved++;
  }
  return moved;
}
