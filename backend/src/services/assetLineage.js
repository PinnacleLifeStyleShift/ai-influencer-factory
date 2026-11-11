import { ApiError } from "../lib/errors.js";
import { missingForUse } from "./rights.js";

/**
 * Rights and cost lineage of distributed media (remediation AIF 1).
 *
 * WHY: a rendered file replaces its shot clips at export, so the URLs of the
 * clips no longer lead to the generation results that made them. Assembly
 * therefore records, per input clip, its checksum and a stable source: the
 * generation application (keyed by its reservation), another AssetVersion
 * (nested assembly) or "manual" (a clip with no generation record). Export
 * walks that lineage, with depth, cycle and character checks, back to the
 * generation results; re-checks today's publication rights of every
 * reference actually sent; and counts each paid generation once.
 *
 * Missing or unverifiable lineage is an error (LINEAGE_UNVERIFIED), never
 * "rights-free" or "no cost".
 */
export const MAX_LINEAGE_DEPTH = 8;
const unverified = (problems) => new ApiError("LINEAGE_UNVERIFIED", 409,
  "Where this media came from cannot be verified, so its rights and costs cannot be checked; nothing was exported", { problems });

/**
 * The source of one clip of an item: its generation application (by the
 * reservation the shot recorded, else the item's latest application for the
 * same media), a rendered AssetVersion of the same character, or manual.
 */
export async function clipSource(prisma, item, clip) {
  if (clip.reservationId) {
    const app = await prisma.generationApplication.findUnique({ where: { reservationId: clip.reservationId } });
    if (!app || app.pipelineItemId !== item.id) {
      throw unverified([{ shotIndex: clip.shotIndex, problem: "the generation record this clip came from is missing or belongs to another item" }]);
    }
    return { inputKind: "generation", reservationId: app.reservationId, application: app };
  }
  const apps = await prisma.generationApplication.findMany({ where: { pipelineItemId: item.id, mediaUrl: clip.url }, orderBy: { appliedAt: "asc" } });
  if (apps.length) return { inputKind: "generation", reservationId: apps.at(-1).reservationId, application: apps.at(-1) };
  const asset = await prisma.assetVersion.findFirst({ where: { storageRef: clip.url }, orderBy: { createdAt: "desc" } });
  if (asset) {
    const owner = await prisma.pipelineItem.findUnique({ where: { id: asset.pipelineItemId }, select: { characterId: true } });
    if (!owner || owner.characterId !== item.characterId) {
      throw unverified([{ shotIndex: clip.shotIndex, problem: "the clip is a rendered file of another character's content" }]);
    }
    return { inputKind: "asset_version", inputAssetVersionId: asset.id, asset };
  }
  return { inputKind: "manual" };
}

/**
 * Walks an AssetVersion's recorded lineage. Returns the generation leaves
 * (application + where it was used) and a display list. Throws
 * LINEAGE_UNVERIFIED for missing lineage, deleted records, cycles, excessive
 * depth or another character's assets.
 */
export async function traceAsset(prisma, assetId, { characterId }) {
  const leaves = [];
  const problems = [];
  async function walk(id, trail) {
    if (trail.includes(id)) { problems.push({ assetVersionId: id, problem: "the recorded lineage contains a cycle" }); return []; }
    if (trail.length >= MAX_LINEAGE_DEPTH) { problems.push({ assetVersionId: id, problem: `nested more than ${MAX_LINEAGE_DEPTH} levels deep` }); return []; }
    const asset = await prisma.assetVersion.findUnique({ where: { id } });
    if (!asset) { problems.push({ assetVersionId: id, problem: "the rendered asset record is missing" }); return []; }
    const owner = await prisma.pipelineItem.findUnique({ where: { id: asset.pipelineItemId }, select: { characterId: true } });
    if (!owner || owner.characterId !== characterId) { problems.push({ assetVersionId: id, problem: "the rendered asset belongs to another character's content" }); return []; }
    const inputs = await prisma.assetLineageInput.findMany({ where: { assetVersionId: id }, orderBy: { position: "asc" } });
    const expected = Array.isArray(asset.provenance?.shots) ? asset.provenance.shots.length : null;
    if (!inputs.length || (expected !== null && inputs.length < expected)) {
      problems.push({ assetVersionId: id, problem: "no lineage was recorded for this rendered file (assemble it again to record it)" });
      return [];
    }
    const out = [];
    for (const input of inputs) {
      const entry = { shotIndex: input.shotIndex, shotKey: input.shotKey, clipSha256: input.clipSha256, source: input.inputKind };
      if (input.inputKind === "generation") {
        const app = input.reservationId ? await prisma.generationApplication.findUnique({ where: { reservationId: input.reservationId } }) : null;
        if (!app || app.pipelineItemId !== asset.pipelineItemId) {
          problems.push({ assetVersionId: id, shotIndex: input.shotIndex, problem: "the generation record this clip came from is missing" });
          continue;
        }
        leaves.push(app);
        out.push({ ...entry, reservationId: app.reservationId, conditioning: app.conditioning, referencesSent: app.referencesSent });
      } else if (input.inputKind === "asset_version") {
        out.push({ ...entry, inputs: await walk(input.inputAssetVersionId, [...trail, id]) });
      } else if (input.inputKind === "manual") {
        out.push(entry);
      } else {
        problems.push({ assetVersionId: id, shotIndex: input.shotIndex, problem: `unknown lineage kind ${input.inputKind}` });
      }
    }
    return out;
  }
  const tree = await walk(assetId, []);
  if (problems.length) throw unverified(problems);
  return { leaves, tree };
}

/**
 * Today's publication rights for every reference fingerprint sent. Returns
 * the manifest rights list; throws RIGHTS_INCOMPLETE if any is not cleared
 * (missing, unapproved, not permitting publication, expired or revoked).
 */
export async function publicationRights(prisma, characterId, fingerprints, now = new Date()) {
  const rights = [];
  const problems = [];
  for (const fp of [...new Set(fingerprints)].filter((f) => f && f !== "none").sort()) {
    const img = await prisma.characterImage.findFirst({ where: { characterId, fingerprint: fp }, include: { rights: { orderBy: { recordedAt: "desc" }, take: 1 } } });
    const rec = img?.rights?.[0] || null;
    if (!img || missingForUse(rec, "publication", now).length) problems.push(fp);
    rights.push({
      referenceFingerprint: fp, imageId: img?.id || null, checksum: img?.checksum || null,
      basis: rec?.basis || null, permittedUses: rec?.permittedUses || [], approved: Boolean(rec?.approvedAt),
      likenessOfRealPerson: rec?.likenessOfRealPerson ?? null,
      consentReference: rec?.consentReference || null, licenseReference: rec?.licenseReference || null,
    });
  }
  if (problems.length) {
    throw new ApiError("RIGHTS_INCOMPLETE", 409, "A reference used for this content has no current rights record that permits publication", { references: problems });
  }
  return rights;
}

/**
 * Cost of the distinct paid generations behind the media: one entry per
 * reservation however often its result is used, per currency, with unknown
 * actual costs counted separately (never as zero).
 */
export function costSummary(reservations) {
  const unique = [...new Map(reservations.filter(Boolean).map((r) => [r.id, r])).values()];
  const byCurrency = {};
  let unknownActual = 0;
  for (const r of unique) {
    if (r.state === "settled" && r.actualMicros !== null && r.actualMicros !== undefined) {
      byCurrency[r.currency] = (byCurrency[r.currency] || 0) + Number(r.actualMicros);
    } else unknownActual++;
  }
  const currencies = Object.keys(byCurrency);
  const single = currencies.length === 1 ? currencies[0] : currencies.length === 0 && unique.length ? unique[0].currency : null;
  return {
    currency: currencies.length <= 1 ? (single ?? null) : null,
    actualKnownMicros: currencies.length <= 1 ? (byCurrency[single] ?? 0) : null,
    byCurrency, paidGenerations: unique.length, unknownActual,
  };
}

/**
 * Adds the paid inputs each result was made from (e.g. the still a video was
 * animated from), recursively and once each. A recorded input whose
 * generation record is gone is unverifiable lineage, never "no input".
 */
export async function withInputs(prisma, applications) {
  const byId = new Map(applications.map((a) => [a.reservationId, a]));
  let pending = applications.flatMap((a) => a.inputReservationIds || []);
  for (let depth = 0; pending.length && depth < MAX_LINEAGE_DEPTH; depth++) {
    const ids = [...new Set(pending)].filter((id) => !byId.has(id));
    if (!ids.length) break;
    const found = await prisma.generationApplication.findMany({ where: { reservationId: { in: ids } } });
    const missing = ids.filter((id) => !found.some((f) => f.reservationId === id));
    if (missing.length) throw unverified(missing.map(() => ({ problem: "the generation record of an input (such as the still a video was made from) is missing" })));
    found.forEach((f) => byId.set(f.reservationId, f));
    pending = found.flatMap((f) => f.inputReservationIds || []);
  }
  return [...byId.values()];
}
