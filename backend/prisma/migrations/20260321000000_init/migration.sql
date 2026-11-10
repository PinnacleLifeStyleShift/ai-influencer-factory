-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "characters" (
    "id" TEXT NOT NULL,
    "character_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "character_type" TEXT,
    "niche" TEXT,
    "persona" TEXT,
    "gender" TEXT,
    "ethnicity" TEXT,
    "eye_color" TEXT,
    "age" TEXT,
    "skin_conditions" TEXT,
    "advanced_features" TEXT,
    "optional_prompt" TEXT,
    "aspect_ratio" TEXT NOT NULL DEFAULT '9:16',
    "quality_setting" TEXT NOT NULL DEFAULT '4K',
    "reference_image_url" TEXT,
    "bopa_background" TEXT,
    "bopa_outfit" TEXT,
    "bopa_poses" TEXT,
    "bopa_angles" TEXT,
    "target_platforms" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "follower_count" INTEGER NOT NULL DEFAULT 0,
    "total_views" INTEGER NOT NULL DEFAULT 0,
    "engagement_rate" TEXT NOT NULL DEFAULT '0.00',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "characters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content_type" TEXT,
    "platform" TEXT,
    "scheduled_date" TEXT,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "caption" TEXT,
    "hashtags" TEXT,
    "motion_prompt" TEXT,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "character_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "platform" TEXT,
    "brief" TEXT,
    "requirements" TEXT,
    "payout_amount" TEXT,
    "deadline" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_submissions" (
    "id" TEXT NOT NULL,
    "submission_url" TEXT,
    "notes" TEXT,
    "payout" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "character_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trends" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "description" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trend_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scripts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "hook" TEXT,
    "body" TEXT,
    "call_to_action" TEXT,
    "platform" TEXT,
    "duration" TEXT,
    "tone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "trend_id" TEXT,
    "character_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_items" (
    "id" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'draft',
    "script_id" TEXT,
    "content_id" TEXT,
    "character_id" TEXT NOT NULL,
    "image_url" TEXT,
    "video_url" TEXT,
    "caption" TEXT,
    "hashtags" TEXT,
    "scheduled_date" TEXT,
    "platform" TEXT,
    "review_notes" TEXT,
    "approved_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "characters_character_id_key" ON "characters"("character_id");

-- AddForeignKey
ALTER TABLE "content" ADD CONSTRAINT "content_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_submissions" ADD CONSTRAINT "campaign_submissions_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_submissions" ADD CONSTRAINT "campaign_submissions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_trend_id_fkey" FOREIGN KEY ("trend_id") REFERENCES "trends"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_items" ADD CONSTRAINT "pipeline_items_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_items" ADD CONSTRAINT "pipeline_items_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "content"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_items" ADD CONSTRAINT "pipeline_items_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

