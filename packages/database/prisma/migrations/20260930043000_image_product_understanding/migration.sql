CREATE TYPE "ImageProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'UNSUPPORTED', 'EXPIRED');
CREATE TYPE "ImageMatchFeedbackType" AS ENUM ('AI_MATCH', 'ADMIN_CORRECTED', 'CUSTOMER_CONFIRMED', 'CUSTOMER_REJECTED');

CREATE TABLE "image_processing" (
  "id" UUID NOT NULL,
  "message_id" UUID NOT NULL,
  "provider_url" TEXT,
  "source_mime_type" VARCHAR(100),
  "detected_mime_type" VARCHAR(100),
  "file_size_bytes" INTEGER,
  "width" INTEGER,
  "height" INTEGER,
  "image_hash" VARCHAR(64),
  "status" "ImageProcessingStatus" NOT NULL DEFAULT 'PENDING',
  "analysis_status" VARCHAR(50),
  "analysis_result" JSONB,
  "candidates" JSONB,
  "confidence_level" VARCHAR(20),
  "selected_product_id" INTEGER,
  "provider" VARCHAR(50),
  "model" VARCHAR(100),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "error_code" VARCHAR(100),
  "vision_duration_ms" INTEGER,
  "matching_duration_ms" INTEGER,
  "ai_duration_ms" INTEGER,
  "total_duration_ms" INTEGER,
  "processing_started_at" TIMESTAMP(3),
  "analyzed_at" TIMESTAMP(3),
  "ai_processed_at" TIMESTAMP(3),
  "retained_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "image_processing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "image_processing_message_id_key" ON "image_processing"("message_id");
CREATE INDEX "image_processing_status_created_at_idx" ON "image_processing"("status", "created_at");
CREATE INDEX "image_processing_image_hash_idx" ON "image_processing"("image_hash");
CREATE INDEX "image_processing_retained_until_idx" ON "image_processing"("retained_until");
ALTER TABLE "image_processing" ADD CONSTRAINT "image_processing_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "image_match_feedback" (
  "id" UUID NOT NULL,
  "message_id" UUID NOT NULL,
  "type" "ImageMatchFeedbackType" NOT NULL,
  "ai_product_id" INTEGER,
  "corrected_product_id" INTEGER,
  "actor" VARCHAR(100),
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "image_match_feedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "image_match_feedback_message_id_created_at_idx" ON "image_match_feedback"("message_id", "created_at");
CREATE INDEX "image_match_feedback_type_created_at_idx" ON "image_match_feedback"("type", "created_at");
ALTER TABLE "image_match_feedback" ADD CONSTRAINT "image_match_feedback_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
