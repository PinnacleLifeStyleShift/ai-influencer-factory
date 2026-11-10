-- AlterTable
ALTER TABLE "pipeline_items" ADD COLUMN     "rights_hold_at" TIMESTAMP(3),
ADD COLUMN     "rights_hold_reason" TEXT;

-- AlterTable
ALTER TABLE "rights_records" ADD COLUMN     "revoke_reason" TEXT,
ADD COLUMN     "revoked_at" TIMESTAMP(3);

