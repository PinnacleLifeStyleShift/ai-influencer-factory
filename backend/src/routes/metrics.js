import { secureRouter } from "../lib/secureRouter.js";
import { ApiError, routeError } from "../lib/errors.js";
import { recordObservation, buildReport, METRICS } from "../services/metrics.js";
import { refreshFromProviders } from "../services/metricsProviders.js";

/** Measurement routes. Recording readings needs "edit"; refreshing from a provider is the owner's. */
export function metricsRoutes({ providers, env }) {
  const router = secureRouter();
  const handle = (label, fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) { return routeError(res, err, `Failed: ${label}`, label); }
  };
  const by = (req) => req.principal?.role || "unknown";
  const plain = (o) => o && ({ ...o, value: Number(o.value) });

  router.get("/subjects", handle("GET /metrics/subjects", async (req, res) => {
    const posts = await req.prisma.publishDelivery.findMany({
      where: { simulated: false, state: { in: ["published", "resolved_published"] } }, include: { job: true }, orderBy: { confirmedAt: "desc" }, take: 200,
    });
    const characters = await req.prisma.character.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
    res.json({ metrics: METRICS, posts: posts.map((p) => ({ id: p.id, platform: p.platform, remotePostId: p.remotePostId, permalink: p.permalink, confirmedAt: p.confirmedAt, originalId: p.job.contentId })), characters });
  }));

  router.get("/providers", handle("GET /metrics/providers", async (req, res) => {
    res.json({ enabled: env.METRICS_API === "enabled", providers: providers.map((p) => ({ name: p.name, platform: p.platform, implemented: Boolean(p.implemented) })) });
  }));

  router.get("/observations", handle("GET /metrics/observations", async (req, res) => {
    const where = {};
    for (const k of ["subjectType", "subjectId", "metric", "source"]) if (typeof req.query[k] === "string") where[k] = req.query[k];
    const rows = await req.prisma.metricObservation.findMany({ where, orderBy: { observedAt: "desc" }, take: 200 });
    res.json(rows.map(plain));
  }));

  router.post("/observations", ["edit"], handle("POST /metrics/observations", async (req, res) => {
    const { observation, replayed } = await recordObservation(req.prisma, req.body, { by: by(req) });
    res.status(replayed ? 200 : 201).json({ replayed, observation: plain(observation) });
  }));

  router.post("/observations/:id/retract", ["edit"], handle("POST /metrics/observations/:id/retract", async (req, res) => {
    const reason = req.body?.reason;
    if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500) throw new ApiError("VALIDATION_FAILED", 400, "reason is required (3-500 characters)");
    // The key is released so the corrected value can be recorded for the same reading.
    const row = await req.prisma.metricObservation.findUnique({ where: { id: req.params.id } });
    const { count } = row ? await req.prisma.metricObservation.updateMany({
      where: { id: row.id, retractedAt: null },
      data: { retractedAt: new Date(), retractReason: `${reason.trim()} (by ${by(req)})`, dedupeKey: `${row.dedupeKey}:retracted:${row.id}` },
    }) : { count: 0 };
    if (count !== 1) {
      const exists = await req.prisma.metricObservation.findUnique({ where: { id: req.params.id } });
      throw exists ? new ApiError("ALREADY_RETRACTED", 409, "This reading is already retracted") : new ApiError("NOT_FOUND", 404, "Reading not found");
    }
    res.json(plain(await req.prisma.metricObservation.findUnique({ where: { id: req.params.id } })));
  }));

  router.get("/report", handle("GET /metrics/report", async (req, res) => {
    const q = req.query;
    res.json(await buildReport(req.prisma, {
      from: q.from, to: q.to, timezone: q.timezone,
      platform: typeof q.platform === "string" && q.platform ? q.platform : undefined,
      characterId: typeof q.characterId === "string" && q.characterId ? q.characterId : undefined,
      includeFixtures: q.includeFixtures === "true",
    }));
  }));

  router.post("/refresh", ["admin"], handle("POST /metrics/refresh", async (req, res) => {
    res.json({ refreshed: await refreshFromProviders(req.prisma, providers, env, { by: by(req) }) });
  }));

  return router;
}
