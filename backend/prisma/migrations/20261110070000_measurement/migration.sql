-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD';

-- CreateTable
CREATE TABLE "metric_observations" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" BIGINT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "source_detail" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retracted_at" TIMESTAMP(3),
    "retract_reason" TEXT,

    CONSTRAINT "metric_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_invoices" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "due_at" TIMESTAMP(3),
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "recorded_by" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_receipts" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "invoice_id" TEXT,
    "amount_micros" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "reference" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "reversed_at" TIMESTAMP(3),
    "reverse_reason" TEXT,
    "recorded_by" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "metric_observations_dedupe_key_key" ON "metric_observations"("dedupe_key");

-- CreateIndex
CREATE INDEX "metric_observations_subject_type_subject_id_metric_idx" ON "metric_observations"("subject_type", "subject_id", "metric");

-- CreateIndex
CREATE INDEX "metric_observations_observed_at_idx" ON "metric_observations"("observed_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_invoices_campaign_id_number_key" ON "campaign_invoices"("campaign_id", "number");

-- AddForeignKey
ALTER TABLE "campaign_invoices" ADD CONSTRAINT "campaign_invoices_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_receipts" ADD CONSTRAINT "campaign_receipts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_receipts" ADD CONSTRAINT "campaign_receipts_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "campaign_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

