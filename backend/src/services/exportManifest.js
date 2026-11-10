import crypto from "crypto";
import { stableStringify } from "./spendLedger.js";
import { snapshotHash, mediaTypeOf } from "../lib/revision.js";
import { inspectMedia } from "./mediaInspect.js";
import { offsetLabel } from "../lib/zonedTime.js";
import { ApiError } from "../lib/errors.js";

/**
 * Export of the approved, immutable version of a pipeline item.
 *
 * WHY deterministic: the manifest holds only facts about the approved
 * content (no export time, no request ids), serialised canonically, so
 * exporting the same approved version twice yields byte-identical JSON and
 * the same manifest hash. Anything not meant for distribution is left out by
 * construction (allow-list): prompts, provider request ids, reservation ids,
 * logs, internal notes, credentials and reference images themselves.
 */
export const MANIFEST_SCHEMA = "ai-influencer-factory/export-manifest@1";
const RATIOS = { "9:16": 9 / 16, "1:1": 1, "16:9": 16 / 9 };

export function approvalIsCurrent(item) {
  return ["approved", "scheduled"].includes(item.stage) &&
    item.approvedRevision === item.revision && item.approvedHash === snapshotHash(item);
}

/** What will actually be distributed: the shot clips, else the video, else the still. */
export function mediaPlan(item) {
  const shots = Array.isArray(item.shotMedia) ? item.shotMedia : [];
  if (shots.length) {
    return [...shots].sort((a, b) => a.shotIndex - b.shotIndex)
      .map((m) => ({ role: "shot", shotIndex: m.shotIndex, kind: m.kind || "video", url: m.url, reportedDurationSec: m.durationSec ?? null, reservationId: m.reservationId || null }));
  }
  const type = mediaTypeOf(item);
  if (!type) return [];
  return [{ role: type, kind: type, url: type === "video" ? item.videoUrl : item.imageUrl, reservationId: null }];
}

const micros = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Reads and checks every media file, then assembles the manifest.
 * Throws ApiError with per-file problems when any check fails.
 */
export async function buildExport(prisma, mediaStore, item) {
  if (!mediaStore?.configured) {
    throw new ApiError("MEDIA_STORE_NOT_CONFIGURED", 409,
      "Export needs media storage to read and verify the files; it is not configured (an owner decision with a cost)");
  }
  const plan = mediaPlan(item);
  if (!plan.length) throw new ApiError("MEDIA_REQUIRED", 409, "There is no media to export");

  const ratio = RATIOS[item.exportSettings?.aspectRatio];
  const media = [];
  const failures = [];
  for (const m of plan) {
    const read = await mediaStore.read(m.url);
    if (!read.ok) { failures.push({ url: m.url, shotIndex: m.shotIndex, problems: [read.problem] }); continue; }
    const info = inspectMedia(read.bytes, { expectedKind: m.kind });
    const problems = [...info.problems];
    if (ratio && info.width && info.height && Math.abs(info.width / info.height - ratio) / ratio > 0.01) {
      problems.push(`aspect ratio ${info.width}x${info.height} does not match the export setting ${item.exportSettings.aspectRatio}`);
    }
    if (m.reportedDurationSec != null && info.durationSec != null && Math.abs(m.reportedDurationSec - info.durationSec) > 0.5) {
      problems.push(`recorded length ${m.reportedDurationSec}s differs from the file's ${info.durationSec}s; measure the media again`);
    }
    if (problems.length) { failures.push({ url: m.url, shotIndex: m.shotIndex, problems }); continue; }
    media.push({ ...m, info });
  }
  if (failures.length) {
    throw new ApiError("EXPORT_MEDIA_INVALID", 422, "Some media failed verification; nothing was exported", { failures });
  }

  // Provenance per file: what made it and what it actually cost.
  const applications = await prisma.generationApplication.findMany({ where: { pipelineItemId: item.id } });
  const reservationIds = new Set(media.map((m) => m.reservationId || applications.filter((a) => a.mediaUrl === m.url).at(-1)?.reservationId).filter(Boolean));
  const reservations = reservationIds.size
    ? await prisma.generationReservation.findMany({ where: { id: { in: [...reservationIds] } } })
    : [];
  const byId = new Map(reservations.map((r) => [r.id, r]));

  const referencesSent = new Set();
  const files = media.map((m) => {
    const app = applications.filter((a) => a.mediaUrl === m.url || a.reservationId === m.reservationId).at(-1);
    (app?.referencesSent || []).forEach((f) => referencesSent.add(f));
    const r = byId.get(m.reservationId || app?.reservationId);
    const settledActual = r && r.state === "settled" && r.actualMicros !== null ? micros(r.actualMicros) : null;
    return {
      role: m.role, ...(m.shotIndex !== undefined ? { shotIndex: m.shotIndex } : {}),
      url: m.url, mime: m.info.mime, bytes: m.info.bytes, sha256: m.info.sha256,
      width: m.info.width, height: m.info.height, durationSec: m.info.durationSec,
      provider: r ? `${r.provider}:${r.model}` : null,
      inputs: app ? { characterVersionId: app.characterVersionId, conditioning: app.conditioning, referencesSent: app.referencesSent } : null,
      cost: r
        ? { currency: r.currency, actualMicros: settledActual, status: settledActual !== null ? "actual" : r.state === "settled" ? "settled_at_estimate" : r.state, priceVersion: r.priceVersion }
        : { status: "no_paid_generation_recorded" },
    };
  });

  // Rights of the references that were actually sent. A reference without an
  // approved record permitting publication blocks export.
  const rights = [];
  const rightsProblems = [];
  for (const fp of [...referencesSent].sort()) {
    const img = await prisma.characterImage.findFirst({ where: { characterId: item.characterId, fingerprint: fp }, include: { rights: { orderBy: { recordedAt: "desc" }, take: 1 } } });
    const rec = img?.rights?.[0];
    if (!rec || !rec.approvedAt || !rec.permittedUses.includes("publication") || (rec.expiresAt && rec.expiresAt < new Date())) {
      rightsProblems.push(fp);
    }
    rights.push({
      referenceFingerprint: fp, imageId: img?.id || null, checksum: img?.checksum || null,
      basis: rec?.basis || null, permittedUses: rec?.permittedUses || [], approved: Boolean(rec?.approvedAt),
      likenessOfRealPerson: rec?.likenessOfRealPerson ?? null,
      consentReference: rec?.consentReference || null, licenseReference: rec?.licenseReference || null,
    });
  }
  if (rightsProblems.length) {
    throw new ApiError("RIGHTS_INCOMPLETE", 409, "A reference used for this content has no approved rights record that permits publication", { references: rightsProblems });
  }

  const sv = item.scriptVersionId ? await prisma.scriptVersion.findUnique({ where: { id: item.scriptVersionId } }) : null;
  const cv = item.characterVersionId ? await prisma.characterVersion.findUnique({ where: { id: item.characterVersionId } }) : null;
  const character = await prisma.character.findUnique({ where: { id: item.characterId }, select: { id: true, name: true } });
  const actualKnown = files.reduce((n, f) => n + (f.cost.actualMicros || 0), 0);

  const manifest = {
    schema: MANIFEST_SCHEMA,
    pipelineItemId: item.id,
    revision: item.revision,
    snapshotHash: item.approvedHash,
    approval: { approvedBy: item.approvedBy, approvedAt: item.approvedAt ? new Date(item.approvedAt).toISOString() : null },
    destination: {
      platform: item.platform,
      schedule: item.scheduledAt
        ? { utc: new Date(item.scheduledAt).toISOString(), timezone: item.scheduleTimezone, local: item.scheduleLocal, offset: offsetLabel(new Date(item.scheduledAt).getTime(), item.scheduleTimezone), note: "Planned time only; nothing has been published" }
        : null,
    },
    caption: item.caption || "",
    hashtags: item.hashtags || "",
    disclosure: item.disclosure,
    exportSettings: item.exportSettings || null,
    character: { id: character?.id, name: character?.name, versionId: cv?.id || null, version: cv?.version ?? null, fictional: true },
    script: sv ? {
      versionId: sv.id, version: sv.version, hook: sv.hook, body: sv.body, callToAction: sv.callToAction,
      targetDurationSec: sv.targetDurationSec,
      evidence: (sv.evidence || []).map((e) => ({ claim: e.claim, basis: e.basis, sourceUrl: e.sourceUrl || null, observedAt: e.observedAt || null })),
    } : null,
    media: files,
    rights,
    cost: { currency: files.find((f) => f.cost.currency)?.cost.currency || null, actualKnownMicros: actualKnown, unknownActualFiles: files.filter((f) => f.cost.status !== "actual" && f.cost.status !== "no_paid_generation_recorded").length },
    excluded: ["generation prompts", "provider request ids", "reservation ids", "internal notes and logs", "credentials", "reference images"],
  };
  const canonical = stableStringify(manifest);
  return { manifest, canonical, manifestHash: crypto.createHash("sha256").update(canonical).digest("hex") };
}

/** Human-readable version of a manifest (same facts, plain text). */
export function readableManifest(manifest, { current }) {
  const lines = [
    `EXPORT MANIFEST${current ? "" : " (SUPERSEDED: the item has changed since this export)"}`,
    `Item ${manifest.pipelineItemId}, revision ${manifest.revision}, approved snapshot ${manifest.snapshotHash}`,
    `Approved by ${manifest.approval.approvedBy} at ${manifest.approval.approvedAt}`,
    `Destination: ${manifest.destination.platform}`,
    manifest.destination.schedule
      ? `Planned for ${manifest.destination.schedule.local} ${manifest.destination.schedule.timezone} (${manifest.destination.schedule.offset}) = ${manifest.destination.schedule.utc} UTC. Planned only; not published.`
      : "No planned time.",
    `Character: ${manifest.character.name} (fictional), version ${manifest.character.version ?? "unpinned"}`,
    `Disclosure: ${manifest.disclosure}`,
    "", "Caption:", manifest.caption, "", `Hashtags: ${manifest.hashtags}`, "", "Media:",
    ...manifest.media.map((f) => `- ${f.role}${f.shotIndex !== undefined ? ` ${f.shotIndex + 1}` : ""}: ${f.mime} ${f.width}x${f.height}${f.durationSec ? ` ${f.durationSec}s` : ""}, ${f.bytes} bytes, sha256 ${f.sha256}, ${f.provider || "no paid generation"}, cost ${f.cost.actualMicros !== null && f.cost.actualMicros !== undefined ? `${(f.cost.actualMicros / 1e6).toFixed(2)} ${f.cost.currency}` : f.cost.status}\n  ${f.url}`),
    "", "Rights of references used:",
    ...(manifest.rights.length ? manifest.rights.map((r) => `- ${r.referenceFingerprint.slice(0, 12)}…: ${r.basis}, permits ${r.permittedUses.join(", ")}`) : ["- none sent"]),
    "", "Evidence for claims:",
    ...((manifest.script?.evidence || []).length ? manifest.script.evidence.map((e) => `- ${e.claim}: ${e.basis}${e.sourceUrl ? ` (${e.sourceUrl})` : ""}`) : ["- none"]),
    "", `Excluded: ${manifest.excluded.join(", ")}`,
  ];
  return lines.join("\n") + "\n";
}
