import { validateBody, listLimit, SCHEMAS } from "../lib/validate.js";
import { ApiError, sendError, routeError } from "../lib/errors.js";
import { Router } from "express";
const router = Router();

// GET /api/campaigns — list all with submissions
router.get("/", async (req, res) => {
  try {
    const campaigns = await req.prisma.campaign.findMany({
      take: listLimit(req),
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
    return routeError(res, err, "Failed to fetch campaigns", "GET /campaigns");
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
    if (!campaign) return sendError(res, new ApiError("NOT_FOUND", 404, "Campaign not found"));
    res.json(campaign);
  } catch (err) {
    return routeError(res, err, "Failed to fetch campaign", "GET /campaigns/:id");
  }
});

// POST /api/campaigns — create
router.post("/", async (req, res) => {
  try {
    validateBody(req.body, SCHEMAS.campaign);
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
    return routeError(res, err, "Failed to create campaign", "POST /campaigns");
  }
});

// PUT /api/campaigns/:id — update
router.put("/:id", async (req, res) => {
  try {
    validateBody(req.body, SCHEMAS.campaign, { partial: true });
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
    return routeError(res, err, "Failed to update campaign", "PUT /campaigns/:id");
  }
});

// DELETE /api/campaigns/:id
router.delete("/:id", async (req, res) => {
  try {
    await req.prisma.campaign.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    return routeError(res, err, "Failed to delete campaign", "DELETE /campaigns/:id");
  }
});

// POST /api/campaigns/:id/submissions — submit character to campaign
router.post("/:id/submissions", async (req, res) => {
  try {
    validateBody(req.body, SCHEMAS.submission);
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
    return routeError(res, err, "Failed to create submission", "POST /campaigns/:id/submissions");
  }
});

export default router;
