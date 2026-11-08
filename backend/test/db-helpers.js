import { PrismaClient } from "@prisma/client";

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
  return new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
}

const TABLES = [
  "generation_reservations", "character_images", "campaign_submissions", "campaigns", "pipeline_items",
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
export async function makeReviewItem(prisma, overrides = {}) {
  const character = await makeCharacter(prisma);
  return prisma.pipelineItem.create({
    data: {
      stage: "review",
      characterId: character.id,
      imageUrl: "https://example.test/still.png",
      caption: "Synthetic caption",
      hashtags: "#synthetic",
      platform: "Instagram",
      ...overrides,
    },
  });
}
