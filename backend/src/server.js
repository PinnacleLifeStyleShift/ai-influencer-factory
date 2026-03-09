import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { PrismaClient } from "@prisma/client";

import characterRoutes from "./routes/characters.js";
import contentRoutes from "./routes/content.js";
import campaignRoutes from "./routes/campaigns.js";
import dashboardRoutes from "./routes/dashboard.js";
import pipelineRoutes from "./routes/pipeline.js";

const prisma = new PrismaClient();
const app = express();
const PORT = parseInt(process.env.PORT) || 4000;

// ─── Middleware ────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(morgan("tiny"));
app.use(express.json());

// Attach prisma to request
app.use((req, _res, next) => {
  req.prisma = prisma;
  next();
});

// ─── Routes ───────────────────────────────────────────────
app.use("/api/characters", characterRoutes);
app.use("/api/content", contentRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/pipeline", pipelineRoutes);

// Health check
app.get("/", (_req, res) => res.json({ status: "ok", service: "ai-influencer-factory-api" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── Error handler ────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API running on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
