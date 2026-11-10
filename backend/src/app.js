import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import characterRoutes from "./routes/characters.js";
import characterImageRoutes from "./routes/characterImages.js";
import contentRoutes from "./routes/content.js";
import campaignRoutes from "./routes/campaigns.js";
import dashboardRoutes from "./routes/dashboard.js";
import pipelineRoutes from "./routes/pipeline.js";
import packageRoutes from "./routes/packages.js";
import exportRoutes from "./routes/exports.js";
import { generationJobRoutes } from "./routes/generationJobs.js";

import { buildCorsOptions } from "./lib/cors.js";
import { sendError, ApiError, routeError } from "./lib/errors.js";
import { requireAuthConfigured, requireSession } from "./middleware/auth.js";
import { allow } from "./auth/permissions.js";
import { onlyFields } from "./lib/requests.js";
import { requestId } from "./middleware/requestId.js";
import { createOwnerTokenProvider } from "./auth/providers.js";
import { createSessionStore } from "./auth/sessions.js";
import { createSessionHandler, authRoutes } from "./routes/auth.js";
import { createAuditLog } from "./services/audit.js";
import { listLimit } from "./lib/validate.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { createGenerationGate, selectLedger } from "./services/generationGate.js";
import { createPrismaLedger } from "./services/spendLedger.js";
import { createMediaStore } from "./services/mediaStore.js";
import { assemblyCapability, assemble } from "./services/mediaAssembly.js";
import { configFindings, readiness } from "./services/opsChecks.js";
import { operationsView, setGenerationPause } from "./services/operations.js";
import { createPublishingGate } from "./services/publishingGate.js";
import { defaultPublishers } from "./services/publishers.js";
import { publishingRoutes } from "./routes/publishing.js";
import { metricsRoutes } from "./routes/metrics.js";
import { defaultMetricsProviders } from "./services/metricsProviders.js";
import { imageAdapters } from "./services/imageGeneration.js";
import { videoAdapters } from "./services/videoGeneration.js";

/**
 * Builds the Express app without listening, so it can be tested locally with
 * a fake Prisma client and no network access.
 */
export function createApp({ prisma, env = process.env, gate, logRequests = true, sessions, authProvider, mediaStore, publishers, publishFaults, publishClock, metricsProviders, assembly } = {}) {
  const media = mediaStore || createMediaStore(env);
  const mediaAssembly = assembly || { capability: () => assemblyCapability(env), assemble };
  // Publishing: real platforms are not implemented; the gate fails closed.
  const publishing = { gate: createPublishingGate({ env, publishers: publishers || defaultPublishers(env) }), faults: publishFaults || null, now: publishClock || (() => new Date()) };
  const sessionStore = sessions || createSessionStore(prisma);
  const provider = authProvider || createOwnerTokenProvider(env);
  const audit = createAuditLog(prisma);

  // One gate per app, injected into every route via req.generationGate.
  const generationGate =
    gate ||
    createGenerationGate({
      env,
      ledger: selectLedger(env, prisma),
      adapters: { image: imageAdapters, video: videoAdapters },
    });

  // Jobs and their reservations live in Postgres, so reconciliation and
  // recovery always settle money in the durable ledger, even if the gate was
  // later switched back to the (refusing) in-memory one.
  const jobLedger = generationGate.ledger?.durable || !prisma?.generationReservation ? generationGate.ledger : createPrismaLedger(prisma);

  const app = express();
  app.disable("x-powered-by");
  // One URL per operation: "/GENERATE-IMAGE" or "/generate-image/" match no
  // route (404) instead of reaching a handler under a different rule.
  app.set("case sensitive routing", true);
  app.set("strict routing", true);
  if (env.TRUST_PROXY) app.set("trust proxy", Number(env.TRUST_PROXY) || 1);

  app.use(requestId());
  // One URL per operation: a repeated separator ("//") is not normalised
  // into a route, it is refused.
  app.use((req, res, next) => (req.path.includes("//") ? sendError(res, new ApiError("NOT_FOUND", 404, "Not found")) : next()));
  app.use(helmet());
  app.use(cors(buildCorsOptions(env)));
  // WHY no query string: a token or other secret pasted into a URL must never
  // reach the logs; the path and request id are enough to trace a request.
  morgan.token("safe-url", (req) => {
    const u = req.originalUrl || req.url || "";
    const i = u.indexOf("?");
    return i < 0 ? u : `${u.slice(0, i)}?[query redacted]`;
  });
  if (logRequests) app.use(morgan(":method :safe-url :status :res[content-length] - :response-time ms id=:res[x-request-id]"));
  app.use(express.json({ limit: "100kb" }));

  // Public, non-sensitive health endpoints.
  app.get("/", (_req, res) => res.json({ status: "ok", service: "ai-influencer-factory-api" }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  // Readiness for deploy health checks: the database answers and every
  // committed migration is applied. Discloses only a status word.
  app.get("/ready", async (_req, res) => {
    const r = await readiness(prisma);
    res.status(r.ready ? 200 : 503).json({ status: r.ready ? "ready" : "not_ready" });
  });

  // Everything under /api requires a session, except creating one.
  const api = express.Router({ caseSensitive: true, strict: true });
  api.use(rateLimit({ windowMs: 60_000, max: Number(env.API_RATE_LIMIT_PER_MIN) || 300 }));
  api.use(requireAuthConfigured(env));
  // Before authentication so refused attempts are recorded as well.
  api.use(audit.middleware());
  // WHY a tight limit: this is the only route that accepts the owner token,
  // so it is the one worth guessing against.
  api.post(
    "/auth/session",
    rateLimit({ windowMs: 60_000, max: Number(env.AUTH_RATE_LIMIT_PER_MIN) || 10, keyFn: (req) => `auth:${req.ip}` }),
    createSessionHandler({ env, provider, sessions: sessionStore })
  );
  api.use(requireSession({ env, sessions: sessionStore }));
  // Authorization is declared on each route (secureRouter / allow), not here.
  api.use((req, _res, next) => {
    req.prisma = prisma;
    req.generationGate = generationGate;
    req.mediaStore = media;
    req.publishing = publishing;
    req.assembly = mediaAssembly;
    next();
  });

  const generationLimiter = rateLimit({
    windowMs: 60_000,
    max: Number(env.GENERATION_RATE_LIMIT_PER_MIN) || 10,
    keyFn: (req) => `gen:${req.ip}`,
  });
  // Middleware, not a route: it applies to the canonical generation URLs (the
  // only ones that reach a handler under strict, case-sensitive routing).
  const GENERATION_PATHS = /^\/(characters\/[^/]+\/generate-(image|video)|pipeline\/generate-content)$/;
  api.use((req, res, next) => (req.method === "POST" && GENERATION_PATHS.test(req.path) ? generationLimiter(req, res, next) : next()));

  // Audit trail (admin only via the permission table). Newest first; page
  // with ?before=<ISO time>; filter with ?targetId=.
  api.get("/audit-events", allow(["admin"]), async (req, res, next) => {
    try {
      const where = {};
      if (typeof req.query.targetId === "string") where.targetId = req.query.targetId;
      if (typeof req.query.before === "string") {
        const before = new Date(req.query.before);
        if (Number.isNaN(before.getTime())) return sendError(res, new ApiError("VALIDATION_FAILED", 400, "before must be an ISO date-time"));
        where.at = { lt: before };
      }
      res.json(await prisma.auditEvent.findMany({ where, orderBy: { at: "desc" }, take: listLimit(req) }));
    } catch (err) { next(err); }
  });

  // Read-only view of what the spending gate would allow (no secrets).
  // Configuration audit by setting NAME only (admin via the permission table).
  api.get("/system/config-check", allow(["admin"]), (_req, res) => res.json({ findings: configFindings(env) }));
  // Operations: open obligations and the runtime generation switch (owner).
  api.get("/system/operations", allow(["admin"]), async (_req, res, next) => {
    try { res.json(await operationsView(prisma)); } catch (err) { next(err); }
  });
  api.post("/system/generation-switch", allow(["admin"]), onlyFields(["paused", "reason"]), async (req, res, next) => {
    try { res.json(await setGenerationPause(prisma, { paused: req.body?.paused, reason: req.body?.reason, by: req.principal?.id })); }
    catch (err) { if (err instanceof ApiError) return sendError(res, err); next(err); }
  });
  api.get("/system/generation-policy", allow(["admin"]), (req, res) => res.json(req.generationGate.describe()));

  api.use("/auth", authRoutes({ sessions: sessionStore }));
  api.use("/characters", characterRoutes);
  api.use("/character-images", characterImageRoutes);
  api.use("/content", contentRoutes);
  api.use("/campaigns", campaignRoutes);
  api.use("/dashboard", dashboardRoutes);
  api.use("/generation-jobs", generationJobRoutes({ gate: generationGate, ledger: jobLedger }));
  api.use("/pipeline", packageRoutes);
  api.use("/pipeline", exportRoutes);
  api.use("/publishing", publishingRoutes());
  api.use("/metrics", metricsRoutes({ providers: metricsProviders || defaultMetricsProviders(), env }));
  api.use("/pipeline", pipelineRoutes);
  api.use((_req, res) => sendError(res, new ApiError("NOT_FOUND", 404, "Not found")));

  app.use("/api", api);
  app.locals.generationGate = generationGate;
  app.locals.jobLedger = jobLedger;

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.too.large") {
      return sendError(res, new ApiError("VALIDATION_FAILED", 413, "Request body too large"));
    }
    if (err?.type === "entity.parse.failed") {
      return sendError(res, new ApiError("VALIDATION_FAILED", 400, "Malformed JSON body"));
    }
    // A malformed %-escape in the path (Express raises URIError, status 400).
    if (err instanceof URIError || (err?.status === 400 && /decode/i.test(err?.message || ""))) {
      return sendError(res, new ApiError("MALFORMED_URL", 400, "Malformed URL"));
    }
    return routeError(res, err, "Internal server error", "unhandled");
  });

  return app;
}
