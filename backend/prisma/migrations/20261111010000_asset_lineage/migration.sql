-- CreateTable
CREATE TABLE "asset_lineage_inputs" (
    "id" TEXT NOT NULL,
    "asset_version_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "shot_index" INTEGER,
    "shot_key" TEXT,
    "clip_sha256" TEXT NOT NULL,
    "input_kind" TEXT NOT NULL,
    "reservation_id" TEXT,
    "input_asset_version_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_lineage_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_lineage_inputs_reservation_id_idx" ON "asset_lineage_inputs"("reservation_id");

-- CreateIndex
CREATE INDEX "asset_lineage_inputs_input_asset_version_id_idx" ON "asset_lineage_inputs"("input_asset_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_lineage_inputs_asset_version_id_position_key" ON "asset_lineage_inputs"("asset_version_id", "position");

