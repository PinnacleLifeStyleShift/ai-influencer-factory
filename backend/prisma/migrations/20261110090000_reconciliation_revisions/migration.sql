-- AlterTable
ALTER TABLE "generation_steps" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "publish_deliveries" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;

