-- AlterTable
ALTER TABLE "generation_reservations" ADD COLUMN     "cap_timezone" TEXT,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN     "price_version" TEXT;

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "workflow_key" TEXT NOT NULL,
    "request_hash" TEXT,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "error_code" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_steps" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "reservation_id" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "provider_request_id" TEXT,
    "vendor_idempotency_key" TEXT,
    "result" JSONB,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_records" (
    "id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "method" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "actual_micros" BIGINT,
    "result_url" TEXT,
    "resolved_by" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_jobs_state_idx" ON "generation_jobs"("state");

-- CreateIndex
CREATE INDEX "generation_jobs_target_id_idx" ON "generation_jobs"("target_id");

-- CreateIndex
CREATE INDEX "generation_steps_state_idx" ON "generation_steps"("state");

-- CreateIndex
CREATE UNIQUE INDEX "generation_steps_job_id_index_key" ON "generation_steps"("job_id", "index");

-- CreateIndex
CREATE INDEX "reconciliation_records_step_id_idx" ON "reconciliation_records"("step_id");

-- AddForeignKey
ALTER TABLE "generation_steps" ADD CONSTRAINT "generation_steps_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "generation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_records" ADD CONSTRAINT "reconciliation_records_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "generation_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

