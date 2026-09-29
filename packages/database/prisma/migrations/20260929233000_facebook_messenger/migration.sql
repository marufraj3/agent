-- CreateEnum
CREATE TYPE "MessengerEventStatus" AS ENUM (
  'received', 'queued', 'processing', 'processed', 'delivery_failed', 'failed', 'ignored'
);

-- AlterTable
ALTER TABLE "messages" ADD COLUMN "external_message_id" VARCHAR(255);
CREATE UNIQUE INDEX "messages_external_message_id_key" ON "messages"("external_message_id");

-- CreateTable
CREATE TABLE "messenger_event_logs" (
  "id" UUID NOT NULL,
  "external_event_id" VARCHAR(255) NOT NULL,
  "external_message_id" VARCHAR(255),
  "event_type" VARCHAR(100) NOT NULL,
  "page_id" VARCHAR(100) NOT NULL,
  "sender_id" VARCHAR(100),
  "status" "MessengerEventStatus" NOT NULL DEFAULT 'received',
  "local_outbound_message_id" UUID,
  "error_message" VARCHAR(500),
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  CONSTRAINT "messenger_event_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "messenger_event_logs_external_event_id_key" ON "messenger_event_logs"("external_event_id");
CREATE INDEX "messenger_event_logs_status_received_at_idx" ON "messenger_event_logs"("status", "received_at");
CREATE INDEX "messenger_event_logs_page_id_received_at_idx" ON "messenger_event_logs"("page_id", "received_at");
CREATE INDEX "messenger_event_logs_external_message_id_idx" ON "messenger_event_logs"("external_message_id");
