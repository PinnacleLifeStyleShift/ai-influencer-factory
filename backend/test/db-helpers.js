import { localOf } from "../src/lib/zonedTime.js";
import { createPrismaClient } from "../src/lib/prisma.js";
import { publishVersion } from "../src/services/characterVersions.js";

/**
 * Integration tests run only against the disposable database created by
 * scripts/with-test-postgres.sh. They refuse any non-localhost URL so they can
 * never truncate a real database.
 */
export const TEST_DB_URL = process.env.TEST_DATABASE_URL || "";

function isLocal(url) {
  try {
    const u = new URL(url);
    return ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}

export const skipReason = !TEST_DB_URL
  ? "TEST_DATABASE_URL not set (npm test starts a disposable local Postgres)"
  : !isLocal(TEST_DB_URL)
    ? "Refusing: TEST_DATABASE_URL must point at localhost"
    : false;

export function newClient() {
  return createPrismaClient(TEST_DB_URL);
}

const TABLES = [
  "export_manifests", "reconciliation_records", "generation_steps", "generation_jobs", "script_versions", "rights_records", "character_versions", "audit_events", "sessions", "generation_reservations", "generation_applications", "character_images", "campaign_submissions", "campaigns", "pipeline_items",
  "scripts", "trends", "content", "characters",
];

export async function resetDb(prisma) {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

let seq = 0;
export async function makeCharacter(prisma, overrides = {}) {
  seq++;
  return prisma.character.create({
    data: { characterId: `TEST-${seq}-${Date.now()}`, name: "Synthetic Test Character", aspectRatio: "9:16", ...overrides },
  });
}

/** A pipeline item ready for review (synthetic URLs on example.test). */
/** A whole hour about 30 days ahead, as 9-ish local time in Los Angeles. */
export function futureSchedule(days = 30, zone = "America/Los_Angeles") {
  const at = new Date(Math.ceil((Date.now() + days * 86400_000) / 3600_000) * 3600_000);
  const local = localOf(at.getTime(), zone);
  return { scheduledAt: at, scheduleTimezone: zone, scheduleLocal: local, scheduledDate: local.slice(0, 10) };
}

export async function makeReviewItem(prisma, overrides = {}) {
  const character = await makeCharacter(prisma);
  // Pinned to a published version, like every item created by generate-script.
  const version = await publishVersion(prisma, character.id, { by: "test" });
  return prisma.pipelineItem.create({
    data: {
      stage: "review",
      characterId: character.id,
      characterVersionId: version.version.id,
      disclosure: "This is a fictional, AI-generated character.",
      imageUrl: "https://example.test/still.png",
      caption: "Synthetic caption",
      hashtags: "#synthetic",
      platform: "Instagram",
      // Destination schedule, part of the approved snapshot (Package E).
      ...futureSchedule(),
      ...overrides,
    },
  });
}
