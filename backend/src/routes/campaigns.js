import { Router } from "express";
const router = Router();

// GET /api/campaigns — list all with submissions
router.get("/", async (req, res) => {
  try {
    const campaigns = await req.prisma.campaign.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        submissions: {
          include: { character: { select: { id: true, name: true, characterId: true } } },
        },
      },
    });

    // Map submissions for frontend compatibility
    const mapped = campaigns.map((c) => ({
      ...c,
      submissions: (c.submissions || []).map((s) => ({
        ...s,
        character_name: s.character?.name || "",
        character_id: s.characterId,
      })),
    }));
    res.json(mapped);
  } catch (err) {
    console.error("GET /campaigns error:", err);
    res.status(500).json({ error: "Failed to fetch campaigns" });
  }
});

// GET /api/campaigns/:id
router.get("/:id", async (req, res) => {
  try {
    const campaign = await req.prisma.campaign.findUnique({
      where: { id: req.params.id },
      include: {
        submissions: {
          include: { character: { select: { id: true, name: true, characterId: true } } },
        },
      },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    res.json(campaign);
  } catch (err) {
    console.error("GET /campaigns/:id error:", err);
    res.status(500).json({ error: "Failed to fetch campaign" });
  }
});

// POST /api/campaigns — create
router.post("/", async (req, res) => {
  try {
    const campaign = await req.prisma.campaign.create({
      data: {
        name: req.body.name,
        brand: req.body.brand,
        platform: req.body.platform,
        brief: req.body.brief,
        requirements: req.body.requirements,
        payoutAmount: req.body.payout_amount || req.body.payoutAmount,
        deadline: req.body.deadline,
        status: req.body.status || "active",
      },
    });
    res.status(201).json({ ...campaign, submissions: [] });
  } catch (err) {
    console.error("POST /campaigns error:", err);
    res.status(500).json({ error: "Failed to create campaign" });
  }
});

// PUT /api/campaigns/:id — update
router.put("/:id", async (req, res) => {
  try {
    const data = {};
    const fields = {
      name: "name", brand: "brand", platform: "platform", brief: "brief",
      requirements: "requirements", payout_amount: "payoutAmount", payoutAmount: "payoutAmount",
      deadline: "deadline", status: "status",
    };
    for (const [bodyKey, prismaKey] of Object.entries(fields)) {
      if (req.body[bodyKey] !== undefined) data[prismaKey] = req.body[bodyKey];
    }
    const campaign = await req.prisma.campaign.update({
      where: { id: req.params.id },
      data,
      include: { submissions: { include: { character: { select: { name: true } } } } },
    });
    res.json(campaign);
  } catch (err) {
    console.error("PUT /campaigns/:id error:", err);
    res.status(500).json({ error: "Failed to update campaign" });
  }
});

// DELETE /api/campaigns/:id
router.delete("/:id", async (req, res) => {
  try {
    await req.prisma.campaign.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /campaigns/:id error:", err);
    res.status(500).json({ error: "Failed to delete campaign" });
  }
});

// POST /api/campaigns/:id/submissions — submit character to campaign
router.post("/:id/submissions", async (req, res) => {
  try {
    const submission = await req.prisma.campaignSubmission.create({
      data: {
        campaignId: req.params.id,
        characterId: req.body.character_id || req.body.characterId,
        submissionUrl: req.body.submission_url || req.body.submissionUrl,
        notes: req.body.notes,
      },
      include: { character: { select: { name: true } } },
    });
    res.status(201).json({ ...submission, character_name: submission.character?.name || "" });
  } catch (err) {
    console.error("POST /campaigns/:id/submissions error:", err);
    res.status(500).json({ error: "Failed to create submission" });
  }
});

export default router;
