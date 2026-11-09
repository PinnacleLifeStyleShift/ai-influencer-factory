import { ApiError } from "../lib/errors.js";

/**
 * Rights and consent for reference images.
 *
 * WHY: a reference image may be a real person's likeness or someone else's
 * work. Before any provider receives it, there must be a recorded basis, a
 * holder, the permitted uses, consent for a real person's likeness, and the
 * owner's approval of that record. Records are append-only; the newest
 * applies. Provider-generated images start with no rights record either:
 * the provider's commercial terms are an open owner decision.
 */
export const BASES = Object.freeze(["generated_synthetic", "owned_original", "licensed", "consented_likeness"]);
export const USES = Object.freeze(["provider_input", "publication", "training"]);

const invalid = (fields) => new ApiError("VALIDATION_FAILED", 400, "Rights record is incomplete or invalid", { fields });

export function validateRightsInput(body) {
  const b = body || {};
  const fields = {};
  if (!BASES.includes(b.basis)) fields.basis = `must be one of ${BASES.join(", ")}`;
  if (typeof b.holder !== "string" || !b.holder.trim() || b.holder.length > 200) fields.holder = "is required (at most 200 characters)";
  if (!Array.isArray(b.permittedUses) || !b.permittedUses.length || b.permittedUses.some((u) => !USES.includes(u))) {
    fields.permittedUses = `must list one or more of ${USES.join(", ")}`;
  }
  const likeness = b.likenessOfRealPerson === true;
  if (b.likenessOfRealPerson !== undefined && typeof b.likenessOfRealPerson !== "boolean") fields.likenessOfRealPerson = "must be true or false";
  if (likeness && b.basis !== "consented_likeness") fields.basis = "a real person's likeness needs basis consented_likeness";
  if ((likeness || b.basis === "consented_likeness") && !(typeof b.consentReference === "string" && b.consentReference.trim())) {
    fields.consentReference = "is required for a real person's likeness (where the signed consent is kept)";
  }
  if (b.basis === "licensed" && !(typeof b.licenseReference === "string" && b.licenseReference.trim())) {
    fields.licenseReference = "is required for licensed material";
  }
  let expiresAt = null;
  if (b.expiresAt !== undefined && b.expiresAt !== null) {
    expiresAt = new Date(b.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) fields.expiresAt = "must be an ISO date-time";
  }
  for (const k of ["consentReference", "licenseReference", "notes"]) {
    if (b[k] !== undefined && b[k] !== null && (typeof b[k] !== "string" || b[k].length > 2000)) fields[k] = "must be a string of at most 2000 characters";
  }
  if (Object.keys(fields).length) throw invalid(fields);
  return {
    basis: b.basis, holder: b.holder.trim(), permittedUses: [...new Set(b.permittedUses)],
    likenessOfRealPerson: likeness, consentReference: b.consentReference || null,
    licenseReference: b.licenseReference || null, expiresAt, notes: b.notes || null,
  };
}

/** Lists what stands between this image and a given use. Empty list = cleared. */
export function missingForUse(record, use, now = new Date()) {
  if (!record) return ["rights record"];
  const missing = [];
  if (!record.permittedUses.includes(use)) missing.push(`permitted use: ${use}`);
  if (record.likenessOfRealPerson && !record.consentReference) missing.push("consent reference");
  if (record.expiresAt && new Date(record.expiresAt) <= now) missing.push("unexpired rights");
  if (!record.approvedAt) missing.push("owner approval of the rights record");
  return missing;
}

export async function latestRights(prisma, imageId) {
  return prisma.rightsRecord.findFirst({ where: { imageId }, orderBy: { recordedAt: "desc" } });
}

export async function clearanceFor(prisma, imageId, use) {
  const record = await latestRights(prisma, imageId);
  const missing = missingForUse(record, use);
  return { imageId, use, cleared: missing.length === 0, missing, rightsRecordId: record?.id || null };
}

export async function recordRights(prisma, imageId, body, { by }) {
  const data = validateRightsInput(body);
  const image = await prisma.characterImage.findUnique({ where: { id: imageId } });
  if (!image) throw new ApiError("NOT_FOUND", 404, "Image not found");
  return prisma.rightsRecord.create({ data: { ...data, imageId, recordedBy: by } });
}

/** Owner approval of the newest record (records are complete by construction). */
export async function approveRights(prisma, imageId, { by, recordId }) {
  const record = await latestRights(prisma, imageId);
  if (!record) throw new ApiError("RIGHTS_MISSING", 409, "No rights record to approve");
  // WHY recordId: approve exactly the record the owner read, not one added since.
  if (recordId && recordId !== record.id) {
    throw new ApiError("RIGHTS_STALE", 409, "A newer rights record exists; review it before approving", { latestRecordId: record.id });
  }
  if (record.approvedAt) return record;
  return prisma.rightsRecord.update({ where: { id: record.id }, data: { approvedBy: by, approvedAt: new Date() } });
}
