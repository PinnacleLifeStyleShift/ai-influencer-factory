-- AlterTable
ALTER TABLE "pipeline_items" ADD COLUMN     "generation_claim" TEXT,
ADD COLUMN     "generation_claimed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "generation_applications" (
    "reservation_id" TEXT NOT NULL,
    "pipeline_item_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "media_url" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_applications_pkey" PRIMARY KEY ("reservation_id")
);

-- CreateIndex
CREATE INDEX "generation_applications_pipeline_item_id_idx" ON "generation_applications"("pipeline_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "character_images_reservation_id_key" ON "character_images"("reservation_id");

