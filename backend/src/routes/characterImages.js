import { secureRouter } from "../lib/secureRouter.js";
import { onlyFields } from "../lib/requests.js";
import { ApiError, routeError } from "../lib/errors.js";
import { recordRights, approveRights, clearanceFor, revokeRights } from "../services/rights.js";
import { USES } from "../services/rights.js";

/** Rights records for character images (see services/rights.js). */
const router = secureRouter();

// GET /api/character-images/:imageId/rights — history (newest first) and clearance per use
router.get("/:imageId/rights", async (req, res) => {
  try {
    const image = await req.prisma.characterImage.findUnique({ where: { id: req.params.imageId } });
    if (!image) throw new ApiError("NOT_FOUND", 404, "Image not found");
    const records = await req.prisma.rightsRecord.findMany({ where: { imageId: image.id }, orderBy: { recordedAt: "desc" }, take: 100 });
    const clearance = Object.fromEntries(await Promise.all(USES.map(async (u) => [u, await clearanceFor(req.prisma, image.id, u)])));
    res.json({ image, records, clearance });
  } catch (err) {
    return routeError(res, err, "Failed to read rights", "GET /character-images/:imageId/rights");
  }
});

// POST /api/character-images/:imageId/rights — append a rights record (needs owner approval to take effect)
router.post("/:imageId/rights", ["references"], onlyFields(["basis", "holder", "permittedUses", "likenessOfRealPerson", "consentReference", "licenseReference", "expiresAt", "notes"]), async (req, res) => {
  try {
    const record = await recordRights(req.prisma, req.params.imageId, req.body, { by: req.principal.id });
    res.status(201).json(record);
  } catch (err) {
    return routeError(res, err, "Failed to record rights", "POST /character-images/:imageId/rights");
  }
});

// POST /api/character-images/:imageId/rights/approve { recordId } — owner approval of the newest record
router.post("/:imageId/rights/approve", ["admin"], onlyFields(["recordId"]), async (req, res) => {
  try {
    const recordId = req.body?.recordId;
    if (typeof recordId !== "string") throw new ApiError("VALIDATION_FAILED", 400, "recordId of the reviewed record is required");
    res.json(await approveRights(req.prisma, req.params.imageId, { by: req.principal.id, recordId }));
  } catch (err) {
    return routeError(res, err, "Failed to approve rights", "POST /character-images/:imageId/rights/approve");
  }
});

// POST /api/character-images/:imageId/rights/revoke { reason } — owner revocation
router.post("/:imageId/rights/revoke", ["admin"], onlyFields(["reason"]), async (req, res) => {
  try {
    res.json(await revokeRights(req.prisma, req.params.imageId, { reason: req.body?.reason, by: req.principal.id }));
  } catch (err) {
    return routeError(res, err, "Failed to revoke rights", "POST /character-images/:imageId/rights/revoke");
  }
});

export default router;
