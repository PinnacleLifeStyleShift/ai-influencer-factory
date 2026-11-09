import { createPrismaClient } from "./lib/prisma.js";
import { createApp } from "./app.js";
import { MIN_TOKEN_LENGTH } from "./middleware/auth.js";

const prisma = createPrismaClient();
const PORT = parseInt(process.env.PORT) || 4000;

const app = createApp({ prisma });

// Jobs left running by a previous process: release what was provably never
// sent, mark the rest for reconciliation. Never blocks startup.
import("./services/generationJobs.js")
  .then(({ recoverAbandoned }) => recoverAbandoned(prisma, app.locals.jobLedger))
  .catch((e) => console.error("startup job recovery failed:", e?.message));

if (!process.env.OWNER_API_TOKEN || process.env.OWNER_API_TOKEN.length < MIN_TOKEN_LENGTH) {
  console.warn(`⚠️  OWNER_API_TOKEN is unset or shorter than ${MIN_TOKEN_LENGTH} chars: all /api routes will refuse requests.`);
}
if (!process.env.FRONTEND_URL) {
  console.warn("⚠️  FRONTEND_URL is unset: no browser origin is granted CORS access.");
}
if (process.env.LIVE_PROVIDER_CALLS === "enabled") {
  console.warn("⚠️  LIVE_PROVIDER_CALLS=enabled. Paid calls still require approval, prices, caps and a durable ledger.");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API running on port ${PORT}`);
});

process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
