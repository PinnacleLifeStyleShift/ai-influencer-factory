-- AlterTable
ALTER TABLE "content" ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "cancelled_by" TEXT,
ADD COLUMN     "schedule_timezone" TEXT,
ADD COLUMN     "scheduled_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "pipeline_items" ADD COLUMN     "schedule_local" TEXT,
ADD COLUMN     "schedule_timezone" TEXT,
ADD COLUMN     "scheduled_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "export_manifests" (
    "id" TEXT NOT NULL,
    "pipeline_item_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot_hash" TEXT NOT NULL,
    "manifest_hash" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "export_manifests_pipeline_item_id_idx" ON "export_manifests"("pipeline_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "export_manifests_pipeline_item_id_manifest_hash_key" ON "export_manifests"("pipeline_item_id", "manifest_hash");

