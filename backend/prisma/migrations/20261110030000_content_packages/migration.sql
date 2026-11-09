-- AlterTable
ALTER TABLE "trends" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'simulated_fixture',
ADD COLUMN     "observation" TEXT,
ADD COLUMN     "observed_at" TIMESTAMP(3),
ADD COLUMN     "recorded_by" TEXT,
ADD COLUMN     "source_url" TEXT,
ALTER COLUMN "trend_score" DROP NOT NULL,
ALTER COLUMN "trend_score" DROP DEFAULT;

-- AlterTable
ALTER TABLE "scripts" ADD COLUMN     "current_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "pipeline_items" ADD COLUMN     "disclosure" TEXT,
ADD COLUMN     "export_settings" JSONB,
ADD COLUMN     "script_version_id" TEXT,
ADD COLUMN     "shot_media" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "script_versions" (
    "id" TEXT NOT NULL,
    "script_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "hook" TEXT,
    "body" TEXT,
    "call_to_action" TEXT,
    "speaking_pace_wpm" INTEGER NOT NULL,
    "target_duration_sec" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "shot_plan" JSONB NOT NULL,
    "planned_duration_sec" DOUBLE PRECISION NOT NULL,
    "character_version_id" TEXT,
    "content_hash" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "script_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "script_versions_script_id_version_key" ON "script_versions"("script_id", "version");

-- AddForeignKey
ALTER TABLE "script_versions" ADD CONSTRAINT "script_versions_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Data: every existing trend row came from the simulated fixture generator,
-- whose scores were random. A random number is not data: clear it.
UPDATE "trends" SET "trend_score" = NULL WHERE "kind" = 'simulated_fixture';
