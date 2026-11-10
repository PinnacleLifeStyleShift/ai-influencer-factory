-- AlterTable
ALTER TABLE "characters" ADD COLUMN     "published_version_id" TEXT;

-- AlterTable
ALTER TABLE "character_images" ADD COLUMN     "character_version_id" TEXT,
ADD COLUMN     "checksum" TEXT,
ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "generation_inputs" JSONB;

-- AlterTable
ALTER TABLE "pipeline_items" ADD COLUMN     "character_version_id" TEXT;

-- AlterTable
ALTER TABLE "generation_applications" ADD COLUMN     "character_version_id" TEXT,
ADD COLUMN     "conditioning" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "prompt_hash" TEXT,
ADD COLUMN     "references_sent" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "character_versions" (
    "id" TEXT NOT NULL,
    "character_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "identity" JSONB NOT NULL,
    "styling" JSONB NOT NULL,
    "references" JSONB NOT NULL DEFAULT '[]',
    "content_hash" TEXT NOT NULL,
    "published_by" TEXT,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "character_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rights_records" (
    "id" TEXT NOT NULL,
    "image_id" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "permitted_uses" TEXT[],
    "likeness_of_real_person" BOOLEAN NOT NULL DEFAULT false,
    "consent_reference" TEXT,
    "license_reference" TEXT,
    "expires_at" TIMESTAMP(3),
    "notes" TEXT,
    "recorded_by" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),

    CONSTRAINT "rights_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "character_versions_character_id_version_key" ON "character_versions"("character_id", "version");

-- CreateIndex
CREATE INDEX "rights_records_image_id_recorded_at_idx" ON "rights_records"("image_id", "recorded_at");

-- AddForeignKey
ALTER TABLE "character_versions" ADD CONSTRAINT "character_versions_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rights_records" ADD CONSTRAINT "rights_records_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "character_images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

