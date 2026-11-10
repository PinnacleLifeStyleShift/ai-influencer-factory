import { Router } from "express";
import { routeError } from "../lib/errors.js";
import { publishContent, recoverPublishJobs, checkDelivery, resolveDelivery } from "../services/publishing.js";

/**
 * Publishing routes. Posting is owner-only ("publish"); reconciliation is an
 * owner decision ("admin"); reading is open. With the default configuration
 * every publish request is refused by the gate before anything is written.
 */
export function publishingRoutes() {
  const router = Router();
  const handle = (label, fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) { return routeError(res, err, `Failed: ${label}`, label); }
  };
  const by = (req) => req.principal?.role || "unknown";

  router.get("/policy", handle("GET /publishing/policy", async (req, res) => res.json(req.publishing.gate.describe())));

  router.get("/jobs", handle("GET /publishing/jobs", async (req, res) => {
    const where = {};
    for (const k of ["contentId", "pipelineItemId"]) if (typeof req.query[k] === "string") where[k] = req.query[k];
    const jobs = await req.prisma.publishJob.findMany({
      where, orderBy: { createdAt: "desc" }, take: 50,
      include: { deliveries: { include: { reconciliations: { orderBy: { resolvedAt: "asc" } } }, orderBy: { platform: "asc" } } },
    });
    res.json(jobs);
  }));

  router.post("/content/:contentId/publish", handle("POST /publishing/content/:contentId/publish", async (req, res) => {
    const job = await publishContent(req.prisma, req.publishing.gate, req.params.contentId, { by: by(req), faults: req.publishing.faults, now: req.publishing.now() });
    res.json({ success: true, job });
  }));

  router.post("/recover", handle("POST /publishing/recover", async (req, res) => {
    res.json({ recovered: await recoverPublishJobs(req.prisma, { now: req.publishing.now() }) });
  }));

  router.post("/deliveries/:id/check", handle("POST /publishing/deliveries/:id/check", async (req, res) => {
    res.json(await checkDelivery(req.prisma, req.publishing.gate, req.params.id, { by: by(req) }));
  }));

  router.post("/deliveries/:id/resolve", handle("POST /publishing/deliveries/:id/resolve", async (req, res) => {
    const { resolution, evidence, remotePostId, permalink } = req.body || {};
    res.json(await resolveDelivery(req.prisma, req.params.id, { resolution, evidence, remotePostId, permalink, by: by(req) }));
  }));

  return router;
}
