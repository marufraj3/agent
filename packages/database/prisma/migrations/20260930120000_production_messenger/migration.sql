-- Step 18: production Messenger reliability, page isolation and outgoing delivery lifecycle.
CREATE TYPE "MessengerConnectionStatus" AS ENUM ('CONNECTED', 'CONNECTION_ERROR', 'DISABLED');
CREATE TYPE "MessengerOutgoingStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'PERMANENT_FAILURE', 'CANCELLED');

ALTER TABLE "customers" ADD COLUMN "platform_page_id" VARCHAR(100) NOT NULL DEFAULT 'global';
DROP INDEX IF EXISTS "customers_platform_platform_user_id_key";
DROP INDEX IF EXISTS "customers_platform_user_id_idx";
CREATE UNIQUE INDEX "customers_platform_platform_page_id_platform_user_id_key" ON "customers"("platform", "platform_page_id", "platform_user_id");
CREATE INDEX "customers_platform_platform_user_id_idx" ON "customers"("platform", "platform_user_id");
CREATE INDEX "customers_platform_page_id_platform_user_id_idx" ON "customers"("platform_page_id", "platform_user_id");

ALTER TABLE "conversations" ADD COLUMN "platform_page_id" VARCHAR(100);
DROP INDEX IF EXISTS "conversations_channel_status_last_message_at_idx";
CREATE INDEX "conversations_channel_platform_page_id_status_last_message_at_idx" ON "conversations"("channel", "platform_page_id", "status", "last_message_at");

ALTER TABLE "messenger_event_logs"
  ADD COLUMN "error_type" VARCHAR(100),
  ADD COLUMN "correlation_id" VARCHAR(128),
  ADD COLUMN "sanitized_payload" JSONB,
  ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "queued_at" TIMESTAMP(3),
  ADD COLUMN "processing_started_at" TIMESTAMP(3),
  ADD COLUMN "processing_completed_at" TIMESTAMP(3),
  ADD COLUMN "response_queued_at" TIMESTAMP(3);
DROP INDEX IF EXISTS "messenger_event_logs_external_message_id_idx";
CREATE INDEX "messenger_event_logs_page_id_external_message_id_idx" ON "messenger_event_logs"("page_id", "external_message_id");
CREATE INDEX "messenger_event_logs_correlation_id_idx" ON "messenger_event_logs"("correlation_id");

CREATE TABLE "messenger_pages" (
  "id" UUID NOT NULL,
  "page_id" VARCHAR(100) NOT NULL,
  "page_name" VARCHAR(255),
  "encrypted_access_token" TEXT,
  "token_hint" VARCHAR(40),
  "connection_status" "MessengerConnectionStatus" NOT NULL DEFAULT 'DISABLED',
  "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
  "ai_config" JSONB,
  "knowledge_base_scope" VARCHAR(100),
  "test_mode" BOOLEAN NOT NULL DEFAULT false,
  "test_recipient_id" VARCHAR(255),
  "last_token_checked_at" TIMESTAMP(3),
  "last_webhook_at" TIMESTAMP(3),
  "last_successful_send_at" TIMESTAMP(3),
  "last_api_error_at" TIMESTAMP(3),
  "last_api_error" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "messenger_pages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "messenger_pages_page_id_key" ON "messenger_pages"("page_id");
CREATE INDEX "messenger_pages_connection_status_updated_at_idx" ON "messenger_pages"("connection_status", "updated_at");

CREATE TABLE "messenger_outgoing_messages" (
  "id" UUID NOT NULL,
  "idempotency_key" VARCHAR(255) NOT NULL,
  "message_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "source_event_log_id" UUID,
  "page_id" VARCHAR(100) NOT NULL,
  "recipient_id" VARCHAR(255) NOT NULL,
  "correlation_id" VARCHAR(128) NOT NULL,
  "status" "MessengerOutgoingStatus" NOT NULL DEFAULT 'QUEUED',
  "provider_message_id" VARCHAR(255),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "error_type" VARCHAR(100),
  "error_code" VARCHAR(100),
  "error_message" VARCHAR(500),
  "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sending_started_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "delivered_at" TIMESTAMP(3),
  "read_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "messenger_outgoing_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "messenger_outgoing_messages_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "messenger_outgoing_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "messenger_outgoing_messages_idempotency_key_key" ON "messenger_outgoing_messages"("idempotency_key");
CREATE UNIQUE INDEX "messenger_outgoing_messages_message_id_key" ON "messenger_outgoing_messages"("message_id");
CREATE UNIQUE INDEX "messenger_outgoing_messages_provider_message_id_key" ON "messenger_outgoing_messages"("provider_message_id");
CREATE INDEX "messenger_outgoing_messages_status_queued_at_idx" ON "messenger_outgoing_messages"("status", "queued_at");
CREATE INDEX "messenger_outgoing_messages_page_id_status_queued_at_idx" ON "messenger_outgoing_messages"("page_id", "status", "queued_at");
CREATE INDEX "messenger_outgoing_messages_conversation_id_created_at_idx" ON "messenger_outgoing_messages"("conversation_id", "created_at");
CREATE INDEX "messenger_outgoing_messages_source_event_log_id_idx" ON "messenger_outgoing_messages"("source_event_log_id");
CREATE INDEX "messenger_outgoing_messages_correlation_id_idx" ON "messenger_outgoing_messages"("correlation_id");

CREATE TABLE "messenger_alerts" (
  "id" UUID NOT NULL,
  "page_id" VARCHAR(100),
  "conversation_id" UUID,
  "message_id" UUID,
  "type" VARCHAR(100) NOT NULL,
  "severity" VARCHAR(20) NOT NULL DEFAULT 'ERROR',
  "message" VARCHAR(500) NOT NULL,
  "metadata" JSONB,
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "messenger_alerts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "messenger_alerts_resolved_at_created_at_idx" ON "messenger_alerts"("resolved_at", "created_at");
CREATE INDEX "messenger_alerts_page_id_created_at_idx" ON "messenger_alerts"("page_id", "created_at");
