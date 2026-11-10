-- AlterTable
ALTER TABLE "pipeline_items" ADD COLUMN     "rendered_asset_id" TEXT;

-- CreateTable
CREATE TABLE "asset_versions" (
    "id" TEXT NOT NULL,
    "pipeline_item_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "codec" TEXT,
    "duration_sec" DOUBLE PRECISION,
    "storage_ref" TEXT NOT NULL,
    "source_job_id" TEXT,
    "provenance" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_versions_pipeline_item_id_idx" ON "asset_versions"("pipeline_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_versions_pipeline_item_id_content_hash_key" ON "asset_versions"("pipeline_item_id", "content_hash");

