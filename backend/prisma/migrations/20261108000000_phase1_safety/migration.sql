-- AlterTable
ALTER TABLE "characters" ADD COLUMN     "image_generations" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "content" ADD COLUMN     "approved_hash" TEXT,
ADD COLUMN     "image_url" TEXT,
ADD COLUMN     "media_type" TEXT,
ADD COLUMN     "schedule_key" TEXT,
ADD COLUMN     "video_url" TEXT;

-- AlterTable
ALTER TABLE "trends" ADD COLUMN     "provenance" TEXT NOT NULL DEFAULT 'unknown';

-- AlterTable
ALTER TABLE "pipeline_items" ADD COLUMN     "active_workflow_key" TEXT,
ADD COLUMN     "approved_by" TEXT,
ADD COLUMN     "approved_hash" TEXT,
ADD COLUMN     "approved_revision" INTEGER,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "character_images" (
    "id" TEXT NOT NULL,
    "character_id" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "source" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "reservation_id" TEXT,
    "generation_index" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_reservations" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "actual_micros" BIGINT,
    "state" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "request_hash" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "character_images_character_id_created_at_idx" ON "character_images"("character_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "character_images_character_id_generation_index_key" ON "character_images"("character_id", "generation_index");

-- CreateIndex
CREATE UNIQUE INDEX "generation_reservations_idempotency_key_key" ON "generation_reservations"("idempotency_key");

-- CreateIndex
CREATE INDEX "generation_reservations_day_idx" ON "generation_reservations"("day");

-- CreateIndex
CREATE INDEX "generation_reservations_month_idx" ON "generation_reservations"("month");

-- CreateIndex
CREATE UNIQUE INDEX "content_schedule_key_key" ON "content"("schedule_key");

-- AddForeignKey
ALTER TABLE "character_images" ADD CONSTRAINT "character_images_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

