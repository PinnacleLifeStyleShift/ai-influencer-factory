-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "sponsor_agreement_ref" TEXT,
ADD COLUMN     "sponsor_authorized_at" TIMESTAMP(3),
ADD COLUMN     "sponsor_authorized_by" TEXT,
ADD COLUMN     "sponsor_disclosure" TEXT,
ADD COLUMN     "sponsor_legal_name" TEXT;

