-- AlterTable
ALTER TABLE "metric_observations" ADD COLUMN     "superseded_at" TIMESTAMP(3),
ADD COLUMN     "superseded_by_id" TEXT;

-- CreateIndex
CREATE INDEX "metric_observations_subject_type_subject_id_metric_period_s_idx" ON "metric_observations"("subject_type", "subject_id", "metric", "period_start", "period_end");

