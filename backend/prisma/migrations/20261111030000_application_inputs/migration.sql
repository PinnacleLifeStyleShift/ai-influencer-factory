-- AlterTable
ALTER TABLE "generation_applications" ADD COLUMN     "input_reservation_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

