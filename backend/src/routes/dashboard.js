import { ApiError, sendError, routeError } from "../lib/errors.js";
import { Router } from "express";
import { moneySummary } from "../services/campaignMoney.js";
const router = Router();

// GET /api/dashboard — aggregated stats for the command center
router.get("/", async (req, res) => {
  try {
    const [characters, content, campaigns] = await Promise.all([
      req.prisma.character.findMany({ orderBy: { totalViews: "desc" } }),
      req.prisma.content.findMany({
        include: { character: { select: { name: true } } },
      }),
      req.prisma.campaign.findMany({
        include: { invoices: true, receipts: true },
      }),
    ]);

    const activeCharacters = characters.filter((c) => c.status === "active").length;
    const byStatus = (st) => content.filter((c) => c.status === st).length;
    const posts = await req.prisma.publishDelivery.findMany({ where: { simulated: false, state: { in: ["published", "resolved_published"] } }, select: { id: true } });
    const readings = await req.prisma.metricObservation.groupBy({ by: ["source"], where: { retractedAt: null }, _max: { recordedAt: true }, _count: { _all: true } });
    const measuredPosts = await req.prisma.metricObservation.findMany({ where: { retractedAt: null, subjectType: "post", source: { in: ["manual", "api"] } }, distinct: ["subjectId"], select: { subjectId: true } });

    res.json({
      characters: {
        total: characters.length,
        active: activeCharacters,
        // Profile counters typed into the character form; no source or date.
        top5: characters.slice(0, 5),
        countersAreSelfReported: true,
      },
      content: {
        total: content.length,
        // Only platform-confirmed posts count as published.
        published: byStatus("published"),
        partiallyPublished: byStatus("partially_published"),
        scheduled: byStatus("scheduled"),
        cancelled: byStatus("cancelled"),
      },
      campaigns: {
        total: campaigns.length,
        active: campaigns.filter((c) => c.status === "active").length,
        // Planned, invoiced and received stay separate; nothing is "earned" until received.
        money: moneySummary(campaigns),
      },
      measurement: {
        confirmedPosts: posts.length,
        postsWithoutReadings: posts.filter((p) => !measuredPosts.some((m) => m.subjectId === p.id)).length,
        sources: Object.fromEntries(readings.map((r) => [r.source, { readings: r._count._all, lastRecordedAt: r._max.recordedAt }])),
      },
    });
  } catch (err) {
    return routeError(res, err, "Failed to fetch dashboard data", "GET /dashboard");
  }
});

export default router;
