import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import characterRoutes from "./routes/characters.js";
import contentRoutes from "./routes/content.js";
import campaignRoutes from "./routes/campaigns.js";
import dashboardRoutes from "./routes/dashboard.js";
import pipelineRoutes from "./routes/pipeline.js";

import { buildCorsOptions } from "./lib/cors.js";
import { sendError, ApiError, routeError } from "./lib/errors.js";
import { requireAuthConfigured, requireSession, authorize } from "./middleware/auth.js";
import { requestId } from "./middleware/requestId.js";
import { createOwnerTokenProvider } from "./auth/providers.js";
import { createSessionStore } from "./auth/sessions.js";
import { createSessionHandler, authRoutes } from "./routes/auth.js";
import { createAuditLog } from "./services/audit.js";
import { listLimit } from "./lib/validate.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { createGenerationGate, selectLedger } from "./services/generationGate.js";
import { imageAdapters } from "./services/imageGeneration.js";
import { videoAdapters } from "./services/videoGeneration.js";

/**
 * Builds the Express app without listening, so it can be tested locally with
 * a fake Prisma client and no network access.
 */
export function createApp({ prisma, env = process.env, gate, logRequests = true, sessions, authProvider } = {}) {
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

  const app = express();
  app.disable("x-powered-by");
  if (env.TRUST_PROXY) app.set("trust proxy", Number(env.TRUST_PROXY) || 1);

  app.use(requestId());
  app.use(helmet());
  app.use(cors(buildCorsOptions(env)));
  if (logRequests) app.use(morgan(":method :url :status :res[content-length] - :response-time ms id=:res[x-request-id]"));
  app.use(express.json({ limit: "100kb" }));

  // Public, non-sensitive health endpoints.
  app.get("/", (_req, res) => res.json({ status: "ok", service: "ai-influencer-factory-api" }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // Everything under /api requires a session, except creating one.
  const api = express.Router();
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
  api.use(authorize());
  api.use((req, _res, next) => {
    req.prisma = prisma;
    req.generationGate = generationGate;
    next();
  });

  const generationLimiter = rateLimit({
    windowMs: 60_000,
    max: Number(env.GENERATION_RATE_LIMIT_PER_MIN) || 10,
    keyFn: (req) => `gen:${req.ip}`,
  });
  api.post(
    ["/characters/:id/generate-image", "/characters/:id/generate-video", "/pipeline/generate-content"],
    generationLimiter
  );

  // Audit trail (admin only via the permission table). Newest first; page
  // with ?before=<ISO time>; filter with ?targetId=.
  api.get("/audit-events", async (req, res, next) => {
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
  api.get("/system/generation-policy", (req, res) => res.json(req.generationGate.describe()));

  api.use("/auth", authRoutes({ sessions: sessionStore }));
  api.use("/characters", characterRoutes);
  api.use("/content", contentRoutes);
  api.use("/campaigns", campaignRoutes);
  api.use("/dashboard", dashboardRoutes);
  api.use("/pipeline", pipelineRoutes);
  api.use((_req, res) => sendError(res, new ApiError("NOT_FOUND", 404, "Not found")));

  app.use("/api", api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.too.large") {
      return sendError(res, new ApiError("VALIDATION_FAILED", 413, "Request body too large"));
    }
    if (err?.type === "entity.parse.failed") {
      return sendError(res, new ApiError("VALIDATION_FAILED", 400, "Malformed JSON body"));
    }
    return routeError(res, err, "Internal server error", "unhandled");
  });

  return app;
}
