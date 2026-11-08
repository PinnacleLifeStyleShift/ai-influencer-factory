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
import { sendError, ApiError } from "./lib/errors.js";
import { requireOwnerToken } from "./middleware/auth.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { initDefaultGate } from "./services/generationGate.js";
import { imageAdapters } from "./services/imageGeneration.js";
import { videoAdapters } from "./services/videoGeneration.js";

/**
 * Builds the Express app without listening, so it can be tested locally with
 * a fake Prisma client and no network access.
 */
export function createApp({ prisma, env = process.env, gate, logRequests = true } = {}) {
  const generationGate =
    gate || initDefaultGate({ env, adapters: { image: imageAdapters, video: videoAdapters } });

  const app = express();
  app.disable("x-powered-by");
  if (env.TRUST_PROXY) app.set("trust proxy", Number(env.TRUST_PROXY) || 1);

  app.use(helmet());
  app.use(cors(buildCorsOptions(env)));
  if (logRequests) app.use(morgan("tiny"));
  app.use(express.json({ limit: "100kb" }));

  // Public, non-sensitive health endpoints.
  app.get("/", (_req, res) => res.json({ status: "ok", service: "ai-influencer-factory-api" }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // Everything under /api requires the owner token.
  const api = express.Router();
  api.use(rateLimit({ windowMs: 60_000, max: Number(env.API_RATE_LIMIT_PER_MIN) || 300 }));
  api.use(requireOwnerToken(env));
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

  // Read-only view of what the spending gate would allow (no secrets).
  api.get("/system/generation-policy", (req, res) => res.json(req.generationGate.describe()));

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
    console.error("Unhandled error:", err?.message || err);
    return sendError(res, err);
  });

  return app;
}
