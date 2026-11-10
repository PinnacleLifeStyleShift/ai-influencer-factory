import { validateBody, listLimit, SCHEMAS } from "../lib/validate.js";
import { recordInvoice, voidInvoice, recordReceipt, reverseReceipt, campaignMoney } from "../services/campaignMoney.js";
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
    // A different sponsor needs its own authorization.
    if (data.brand !== undefined) {
      const current = await req.prisma.campaign.findUnique({ where: { id: req.params.id } });
      if (current && (current.brand ?? null) !== (data.brand ?? null)) {
        Object.assign(data, { sponsorLegalName: null, sponsorAgreementRef: null, sponsorAuthorizedAt: null, sponsorAuthorizedBy: null, sponsorDisclosure: null });
      }
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
    // Invoices and receipts are financial records: a campaign that has them is kept.
    const records = await req.prisma.campaignInvoice.count({ where: { campaignId: req.params.id } }) + await req.prisma.campaignReceipt.count({ where: { campaignId: req.params.id } });
    if (records) throw new ApiError("CAMPAIGN_HAS_MONEY_RECORDS", 409, "This campaign has invoices or receipts; close it instead of deleting it");
    await req.prisma.campaign.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    return routeError(res, err, "Failed to delete campaign", "DELETE /campaigns/:id");
  }
});

// ─── Sponsor authorization (brief section 3) ────────────────
// WHY: promoting a brand needs a real, authorized relationship and a paid-
// promotion disclosure. A campaign without one cannot take submissions.
const DISCLOSURE_RE = /(#ad\b|#sponsored\b|paid partnership|paid promotion|sponsored by|#partner\b)/i;
router.post("/:id/sponsor-authorization", async (req, res) => {
  try {
    const { sponsorLegalName, agreementReference, authorizedAt, disclosure } = req.body || {};
    const fields = {};
    if (typeof sponsorLegalName !== "string" || sponsorLegalName.trim().length < 2 || sponsorLegalName.length > 200) fields.sponsorLegalName = "is required (the sponsor's legal name)";
    if (typeof agreementReference !== "string" || agreementReference.trim().length < 3 || agreementReference.length > 200) fields.agreementReference = "is required (where the signed agreement is kept)";
    const at = typeof authorizedAt === "string" ? new Date(authorizedAt) : null;
    if (!at || Number.isNaN(at.getTime()) || at > new Date()) fields.authorizedAt = "is required and cannot be in the future";
    if (typeof disclosure !== "string" || !DISCLOSURE_RE.test(disclosure) || disclosure.length > 300) fields.disclosure = "must contain a clear paid-promotion label (e.g. #ad, Paid partnership with …)";
    if (Object.keys(fields).length) throw new ApiError("VALIDATION_FAILED", 400, "Sponsor authorization is incomplete", { fields });
    const exists = await req.prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!exists) return sendError(res, new ApiError("NOT_FOUND", 404, "Campaign not found"));
    const campaign = await req.prisma.campaign.update({ where: { id: req.params.id }, data: {
      sponsorLegalName: sponsorLegalName.trim(), sponsorAgreementRef: agreementReference.trim(), sponsorAuthorizedAt: at,
      sponsorAuthorizedBy: req.principal?.role || "unknown", sponsorDisclosure: disclosure.trim(),
    } });
    res.json(campaign);
  } catch (err) {
    return routeError(res, err, "Failed to record sponsor authorization", "POST /campaigns/:id/sponsor-authorization");
  }
});

// ─── Money: planned / invoiced / received (separate states) ──
const by = (req) => req.principal?.role || "unknown";
const plainMoney = (r) => ({ ...r, amountMicros: Number(r.amountMicros) });
const moneyRoute = (label, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { return routeError(res, err, `Failed: ${label}`, label); }
};
router.get("/:id/money", moneyRoute("GET /campaigns/:id/money", async (req, res) => res.json(await campaignMoney(req.prisma, req.params.id))));
router.post("/:id/invoices", moneyRoute("POST /campaigns/:id/invoices", async (req, res) =>
  res.status(201).json(plainMoney(await recordInvoice(req.prisma, req.params.id, req.body, { by: by(req) })))));
router.post("/:id/invoices/:invoiceId/void", moneyRoute("POST /campaigns/:id/invoices/:invoiceId/void", async (req, res) =>
  res.json(plainMoney(await voidInvoice(req.prisma, req.params.id, req.params.invoiceId, req.body?.reason, { by: by(req) })))));
router.post("/:id/receipts", moneyRoute("POST /campaigns/:id/receipts", async (req, res) =>
  res.status(201).json(plainMoney(await recordReceipt(req.prisma, req.params.id, req.body, { by: by(req) })))));
router.post("/:id/receipts/:receiptId/reverse", moneyRoute("POST /campaigns/:id/receipts/:receiptId/reverse", async (req, res) =>
  res.json(plainMoney(await reverseReceipt(req.prisma, req.params.id, req.params.receiptId, req.body?.reason, { by: by(req) })))));

// POST /api/campaigns/:id/submissions — submit character to campaign
router.post("/:id/submissions", async (req, res) => {
  try {
    validateBody(req.body, SCHEMAS.submission);
    const campaign = await req.prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) return sendError(res, new ApiError("NOT_FOUND", 404, "Campaign not found"));
    if (!campaign.sponsorAuthorizedAt || !campaign.sponsorAgreementRef || !campaign.sponsorDisclosure) {
      throw new ApiError("SPONSOR_AUTHORIZATION_REQUIRED", 409, "Record the sponsor's authorization (agreement and paid-promotion disclosure) before submitting characters");
    }
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
