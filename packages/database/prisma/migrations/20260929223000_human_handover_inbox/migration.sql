-- CreateEnum
CREATE TYPE "HandoverReason" AS ENUM (
  'customer_requested_human', 'ai_uncertain', 'repeated_failure', 'complaint',
  'refund_request', 'exchange_request', 'order_problem', 'payment_problem',
  'unavailable_product', 'complex_question', 'abusive_customer', 'other'
);
CREATE TYPE "HandoverStatus" AS ENUM ('pending', 'assigned', 'resolved', 'cancelled');

-- AlterTable
ALTER TABLE "conversations"
  ADD COLUMN "assigned_to" VARCHAR(100),
  ADD COLUMN "unread_for_admin" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "consecutive_ai_failures" INTEGER NOT NULL DEFAULT 0;

-- Ensure a human-owned and an AI-owned conversation cannot exist concurrently for one customer/channel.
-- Older releases allowed a new active conversation beside a human-owned one; retain the newest human
-- conversation where present and close other engaged duplicates before installing the stronger invariant.
WITH ranked_engaged AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "customer_id", "channel"
    ORDER BY CASE WHEN "status" = 'human' THEN 0 ELSE 1 END, "last_message_at" DESC, "id" DESC
  ) AS position
  FROM "conversations"
  WHERE "status" IN ('active', 'human')
)
UPDATE "conversations" AS conversation
SET "status" = 'closed', "updated_at" = CURRENT_TIMESTAMP
FROM ranked_engaged
WHERE conversation."id" = ranked_engaged."id" AND ranked_engaged.position > 1;

DROP INDEX IF EXISTS "conversations_one_active_customer_channel_key";
CREATE UNIQUE INDEX "conversations_one_engaged_customer_channel_key"
ON "conversations"("customer_id", "channel") WHERE "status" IN ('active', 'human');

-- CreateTable
CREATE TABLE "conversation_handovers" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "reason" "HandoverReason" NOT NULL,
  "note" TEXT,
  "status" "HandoverStatus" NOT NULL DEFAULT 'pending',
  "assigned_to" VARCHAR(100),
  "created_by" VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  "resolved_by" VARCHAR(100),
  CONSTRAINT "conversation_handovers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admin_notifications" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "handover_id" UUID,
  "type" VARCHAR(100) NOT NULL,
  "message" VARCHAR(500) NOT NULL,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_notifications_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "conversations_status_assigned_to_last_message_at_idx" ON "conversations"("status", "assigned_to", "last_message_at");
CREATE INDEX "conversations_unread_for_admin_last_message_at_idx" ON "conversations"("unread_for_admin", "last_message_at");
CREATE INDEX "conversation_handovers_status_created_at_idx" ON "conversation_handovers"("status", "created_at");
CREATE INDEX "conversation_handovers_assigned_to_status_created_at_idx" ON "conversation_handovers"("assigned_to", "status", "created_at");
CREATE INDEX "conversation_handovers_conversation_id_created_at_idx" ON "conversation_handovers"("conversation_id", "created_at");
CREATE INDEX "admin_notifications_read_at_created_at_idx" ON "admin_notifications"("read_at", "created_at");
CREATE INDEX "admin_notifications_conversation_id_created_at_idx" ON "admin_notifications"("conversation_id", "created_at");
-- One unresolved handover per conversation.
CREATE UNIQUE INDEX "conversation_handovers_one_open_key"
ON "conversation_handovers"("conversation_id") WHERE "status" IN ('pending', 'assigned');

-- Foreign keys
ALTER TABLE "conversation_handovers" ADD CONSTRAINT "conversation_handovers_conversation_id_fkey"
FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_notifications" ADD CONSTRAINT "admin_notifications_conversation_id_fkey"
FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_notifications" ADD CONSTRAINT "admin_notifications_handover_id_fkey"
FOREIGN KEY ("handover_id") REFERENCES "conversation_handovers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
