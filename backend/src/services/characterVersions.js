import crypto from "crypto";
import { ApiError } from "../lib/errors.js";
import { stableStringify } from "./spendLedger.js";

/**
 * Character versions.
 *
 * WHY this shape: the Character row stays the single editable draft (so the
 * existing editor keeps working), and "publish" freezes it into an immutable
 * CharacterVersion. Content pins a version id, so later edits or newer
 * versions can never change what earlier (possibly approved) content was
 * made from.
 *
 * identity = what must stay recognisably the same across all content.
 * styling  = per-shot defaults that a scene may legitimately vary.
 */
export const IDENTITY_FIELDS = Object.freeze([
  "name", "characterType", "niche", "persona", "gender", "ethnicity", "eyeColor",
  "age", "skinConditions", "advancedFeatures",
]);
export const STYLING_FIELDS = Object.freeze([
  "aspectRatio", "qualitySetting", "bopaBackground", "bopaOutfit", "bopaPoses",
  "bopaAngles", "optionalPrompt", "targetPlatforms",
]);

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Identity of a URL-only asset. Not a byte checksum: media is not stored yet. */
export const fingerprintUrl = (url) => sha256(`url:${url}`);
export const promptHash = (prompt) => sha256(`prompt:${prompt}`);

export function snapshotOf(character) {
  const pick = (fields) => Object.fromEntries(fields.map((f) => [f, character[f] ?? null]));
  return { identity: pick(IDENTITY_FIELDS), styling: pick(STYLING_FIELDS) };
}

export function contentHashOf({ identity, styling, references }) {
  return sha256(stableStringify({ identity, styling, references: references.map((r) => r.fingerprint) }));
}

/** Fields buildPromptFromCharacter reads, taken from a version (not the live draft). */
export function promptSourceOf(version) {
  return { ...version.identity, ...version.styling };
}

/** The reference image currently marked on the draft, registered as an asset if it was set by URL. */
async function currentReferences(tx, character) {
  if (!character.referenceImageUrl) return [];
  let image = await tx.characterImage.findFirst({
    where: { characterId: character.id, imageUrl: character.referenceImageUrl },
    orderBy: { createdAt: "desc" },
  });
  if (!image) {
    // A legacy reference set by URL before reference tracking existed.
    image = await tx.characterImage.create({
      data: {
        characterId: character.id, imageUrl: character.referenceImageUrl, status: "reference",
        source: "manual", fingerprint: fingerprintUrl(character.referenceImageUrl),
      },
    });
  }
  return [{ imageId: image.id, fingerprint: image.fingerprint || fingerprintUrl(image.imageUrl), checksum: image.checksum || null }];
}

/**
 * Freezes the current draft. Idempotent: if nothing changed since the latest
 * published version, that version is returned with unchanged: true.
 */
export async function publishVersion(prisma, characterId, { by, note } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const character = await tx.character.findUnique({ where: { id: characterId } });
        if (!character) throw new ApiError("NOT_FOUND", 404, "Character not found");
        const { identity, styling } = snapshotOf(character);
        const references = await currentReferences(tx, character);
        const contentHash = contentHashOf({ identity, styling, references });

        const latest = await tx.characterVersion.findFirst({ where: { characterId }, orderBy: { version: "desc" } });
        if (latest && latest.contentHash === contentHash) return { version: latest, unchanged: true };

        const version = await tx.characterVersion.create({
          data: {
            characterId, version: (latest?.version || 0) + 1, identity, styling, references, contentHash,
            publishedBy: by || null, note: note || null,
          },
        });
        await tx.character.update({ where: { id: characterId }, data: { publishedVersionId: version.id } });
        return { version, unchanged: false };
      });
    } catch (err) {
      // Two publishes at once: the unique (character, version) index lets one win; retry the other.
      if (err?.code !== "P2002" || attempt === 2) throw err;
    }
  }
  throw new Error("unreachable");
}

/** The latest published version, publishing the current draft as v1 if there is none yet. */
export async function ensurePublishedVersion(prisma, character, { by } = {}) {
  if (character.publishedVersionId) {
    const v = await prisma.characterVersion.findUnique({ where: { id: character.publishedVersionId } });
    if (v) return v;
  }
  return (await publishVersion(prisma, character.id, { by, note: "Created automatically for content pinning" })).version;
}

/** Copies a version back into the editable draft (the reference stays as it is). */
export async function restoreDraft(prisma, characterId, versionNumber) {
  const version = await prisma.characterVersion.findUnique({
    where: { characterId_version: { characterId, version: versionNumber } },
  });
  if (!version) throw new ApiError("NOT_FOUND", 404, "Version not found");
  const data = { ...version.identity, ...version.styling };
  if (data.targetPlatforms === null) data.targetPlatforms = [];
  return prisma.character.update({ where: { id: characterId }, data });
}
