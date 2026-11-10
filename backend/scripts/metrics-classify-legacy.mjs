#!/usr/bin/env node
/**
 * Dry run: lists windows of one metric series that have more than one
 * effective period reading (rows stored before "one value per window").
 * Reads only. Nothing is changed, merged or deleted; a conflicting window is
 * resolved by the owner recording a corrected reading, which supersedes the
 * others and keeps them as history.
 *
 * Usage: DATABASE_URL=... node scripts/metrics-classify-legacy.mjs
 * Output: JSON with counts and observation ids (no credentials, no values).
 */
import { createPrismaClient } from "../src/lib/prisma.js";
import { classifyLegacyPeriodReadings } from "../src/services/metrics.js";

const prisma = createPrismaClient();
try {
  const result = await classifyLegacyPeriodReadings(prisma);
  const summary = {
    dryRun: true,
    periodReadings: result.periodReadings,
    windowsWithRepeats: result.groups.filter((g) => g.classification === "identical_repeats").length,
    windowsWithConflicts: result.groups.filter((g) => g.classification === "conflicting_values").length,
    groups: result.groups.map(({ subjectType, subjectId, platform, metric, source, periodStart, periodEnd, readings, distinctValues, classification, observationIds }) =>
      ({ subjectType, subjectId, platform, metric, source, periodStart, periodEnd, readings, distinctValues, classification, observationIds })),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
} finally {
  await prisma.$disconnect();
}
