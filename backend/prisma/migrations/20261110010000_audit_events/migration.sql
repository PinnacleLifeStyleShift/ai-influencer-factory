-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "actor_role" TEXT,
    "session_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "status" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "error_code" TEXT,
    "request_id" TEXT,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_at_idx" ON "audit_events"("at");

-- CreateIndex
CREATE INDEX "audit_events_target_id_idx" ON "audit_events"("target_id");

-- CreateIndex
CREATE INDEX "audit_events_actor_id_idx" ON "audit_events"("actor_id");

