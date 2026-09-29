-- Durable lifecycle state for voice messages. Audio bytes are intentionally not stored.
CREATE TYPE "AudioTranscriptionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'UNSUPPORTED', 'EXPIRED');

CREATE TABLE "audio_transcriptions" (
  "id" UUID NOT NULL,
  "message_id" UUID NOT NULL,
  "provider_url" TEXT,
  "source_mime_type" VARCHAR(100),
  "detected_mime_type" VARCHAR(100),
  "duration_seconds" DOUBLE PRECISION,
  "file_size_bytes" INTEGER,
  "status" "AudioTranscriptionStatus" NOT NULL DEFAULT 'PENDING',
  "original_transcript" TEXT,
  "normalized_transcript" TEXT,
  "language" VARCHAR(20),
  "confidence" DOUBLE PRECISION,
  "provider" VARCHAR(50),
  "model" VARCHAR(100),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "error_code" VARCHAR(100),
  "stt_duration_ms" INTEGER,
  "ai_duration_ms" INTEGER,
  "total_duration_ms" INTEGER,
  "processing_started_at" TIMESTAMP(3),
  "transcribed_at" TIMESTAMP(3),
  "ai_processed_at" TIMESTAMP(3),
  "retained_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "audio_transcriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "audio_transcriptions_message_id_key" ON "audio_transcriptions"("message_id");
CREATE INDEX "audio_transcriptions_status_created_at_idx" ON "audio_transcriptions"("status", "created_at");
CREATE INDEX "audio_transcriptions_retained_until_idx" ON "audio_transcriptions"("retained_until");
ALTER TABLE "audio_transcriptions" ADD CONSTRAINT "audio_transcriptions_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
