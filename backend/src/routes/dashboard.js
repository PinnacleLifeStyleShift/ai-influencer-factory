import { Router } from "express";
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
        include: {
          submissions: {
            include: { character: { select: { name: true } } },
          },
        },
      }),
    ]);

    const activeCharacters = characters.filter((c) => c.status === "active").length;
    const published = content.filter((c) => c.status === "published").length;
    const scheduled = content.filter((c) => c.status === "scheduled").length;
    const activeCampaigns = campaigns.filter((c) => c.status === "active").length;
    const totalEarned = campaigns.reduce(
      (s, c) => s + (c.submissions || []).reduce((a, b) => a + (b.payout || 0), 0),
      0
    );

    res.json({
      characters: {
        total: characters.length,
        active: activeCharacters,
        top5: characters.slice(0, 5),
      },
      content: {
        total: content.length,
        published,
        scheduled,
      },
      campaigns: {
        total: campaigns.length,
        active: activeCampaigns,
        totalEarned,
      },
    });
  } catch (err) {
    console.error("GET /dashboard error:", err);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});

export default router;
