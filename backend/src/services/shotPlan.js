import crypto from "crypto";

/**
 * Shot planning and duration checks.
 *
 * WHY: a 5-second clip must never be labelled a 30-second video. The plan
 * derives each shot's time from the words spoken at the chosen pace, adds
 * visual hold time only to reach the target, and flags (never hides) a
 * script that cannot fit. Measured durations come from media metadata and
 * are compared to the plan with a documented tolerance.
 */
export const DEFAULT_PACE_WPM = 150;
export const MIN_SHOT_SEC = 1.5;
/** Allowed difference between target and planned/measured: max(1 s, 10 %). */
export const toleranceSec = (targetSec) => Math.max(1, targetSec * 0.1);

const round1 = (n) => Math.round(n * 10) / 10;
const words = (t) => (t || "").trim().split(/\s+/).filter(Boolean).length;
export const speechSeconds = (text, wpm) => (words(text) / wpm) * 60;

/** "30s" / 30 / "30" -> 30; anything else -> null. */
export function parseDurationSec(v) {
  if (Number.isInteger(v)) return v;
  const m = /^(\d{1,3})s?$/.exec(String(v ?? "").trim());
  return m ? Number(m[1]) : null;
}

function sentences(text) {
  return (text || "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/** Stable identity of a shot's content, used to keep media that still fits after an edit. */
export function shotKey(shot) {
  return crypto.createHash("sha256").update(JSON.stringify([shot.dialogue, shot.visualAction, shot.scene])).digest("hex").slice(0, 16);
}

/**
 * Builds a shot plan from a script and the pinned character version.
 * Returns { shots, plannedDurationSec, speechSec, durationCheck }.
 */
export function planShots({ hook, body, callToAction, targetDurationSec, speakingPaceWpm = DEFAULT_PACE_WPM, characterVersion }) {
  const lines = [
    ...(hook ? [{ role: "hook", text: hook }] : []),
    ...sentences(body).map((text) => ({ role: "body", text })),
    ...(callToAction ? [{ role: "cta", text: callToAction }] : []),
  ];
  const styling = characterVersion?.styling || {};
  const refs = (characterVersion?.references || []).map((r) => r.fingerprint);
  const scene = styling.bopaBackground || "Neutral studio set";
  const baseAction = [styling.bopaPoses, styling.bopaAngles].filter(Boolean).join(", ") || "Speaks to camera, natural gestures";

  const shots = lines.map((l, i) => {
    const speech = speechSeconds(l.text, speakingPaceWpm);
    return {
      index: i,
      role: l.role,
      scene,
      visualAction: l.role === "hook" ? `Opens close-up. ${baseAction}` : l.role === "cta" ? `Direct to camera. ${baseAction}` : baseAction,
      dialogue: l.text,
      caption: l.text.length > 80 ? `${l.text.slice(0, 77)}...` : l.text,
      transition: i === 0 ? "none" : "cut",
      speechSec: round1(speech),
      holdSec: 0,
      durationSec: round1(Math.max(MIN_SHOT_SEC, speech)),
      characterVersionId: characterVersion?.id || null,
      referenceFingerprints: refs,
      // Voice is the character's own synthetic line; no third-party music is planned.
      audio: { kind: "voice", music: "none", rightsStatus: "not_required" },
    };
  });

  const speechTotal = shots.reduce((t, s) => t + s.durationSec, 0);
  // Visual hold time (b-roll, pauses) only to reach the target, spread evenly.
  if (targetDurationSec && speechTotal < targetDurationSec && shots.length) {
    const extra = (targetDurationSec - speechTotal) / shots.length;
    for (const s of shots) {
      s.holdSec = round1(extra);
      s.durationSec = round1(s.durationSec + extra);
    }
  }
  for (const s of shots) s.shotKey = shotKey(s);
  const planned = round1(shots.reduce((t, s) => t + s.durationSec, 0));
  return { shots, plannedDurationSec: planned, speechSec: round1(speechTotal), durationCheck: checkDuration(targetDurationSec, planned) };
}

export function checkDuration(targetSec, actualSec) {
  const tol = toleranceSec(targetSec);
  const delta = round1(actualSec - targetSec);
  return { targetSec, actualSec: round1(actualSec), deltaSec: delta, toleranceSec: round1(tol), withinTolerance: Math.abs(delta) <= tol };
}

/**
 * Package duration from attached media: each shot contributes the part of
 * its clip that the plan uses (a clip shorter than its shot leaves a gap).
 * "verified" only when every shot's duration was reported by the media
 * source rather than merely requested.
 */
export function measurePackage(shots, shotMedia, targetSec) {
  const byIndex = new Map((shotMedia || []).map((m) => [m.shotIndex, m]));
  let total = 0;
  let verified = true;
  const perShot = shots.map((s) => {
    const m = byIndex.get(s.index);
    const valid = m && m.shotKey === s.shotKey;
    if (!valid) { verified = false; return { index: s.index, status: m ? "stale" : "missing", usedSec: 0, shortBySec: s.durationSec }; }
    if (m.durationSource !== "provider_reported" && m.durationSource !== "measured") verified = false;
    const used = Math.min(m.durationSec || 0, s.durationSec);
    total += used;
    return { index: s.index, status: "ok", usedSec: round1(used), shortBySec: round1(Math.max(0, s.durationSec - used)), durationSource: m.durationSource };
  });
  const complete = perShot.every((p) => p.status === "ok" && p.shortBySec === 0);
  return { perShot, measuredSec: round1(total), complete, verified, check: checkDuration(targetSec, total) };
}
