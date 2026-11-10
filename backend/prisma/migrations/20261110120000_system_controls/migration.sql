-- CreateTable
CREATE TABLE "system_controls" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "reason" TEXT,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_controls_pkey" PRIMARY KEY ("key")
);

