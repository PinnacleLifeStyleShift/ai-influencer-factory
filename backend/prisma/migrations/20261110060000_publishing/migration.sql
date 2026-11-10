-- AlterTable
ALTER TABLE "pipeline_items" ADD COLUMN     "cross_post_destinations" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "publish_jobs" (
    "id" TEXT NOT NULL,
    "content_id" TEXT NOT NULL,
    "pipeline_item_id" TEXT NOT NULL,
    "snapshot_hash" TEXT NOT NULL,
    "manifest_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publish_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_deliveries" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "account_ref" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "client_ref" TEXT,
    "remote_request_id" TEXT,
    "remote_post_id" TEXT,
    "permalink" TEXT,
    "error_code" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "submitted_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publish_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_reconciliations" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "remote_post_id" TEXT,
    "permalink" TEXT,
    "resolved_by" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publish_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "publish_jobs_content_id_key" ON "publish_jobs"("content_id");

-- CreateIndex
CREATE UNIQUE INDEX "publish_deliveries_job_id_platform_key" ON "publish_deliveries"("job_id", "platform");

-- CreateIndex
CREATE INDEX "publish_reconciliations_delivery_id_idx" ON "publish_reconciliations"("delivery_id");

-- AddForeignKey
ALTER TABLE "publish_deliveries" ADD CONSTRAINT "publish_deliveries_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "publish_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_reconciliations" ADD CONSTRAINT "publish_reconciliations_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "publish_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

