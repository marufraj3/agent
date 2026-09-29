ALTER TABLE "conversations"
  ADD COLUMN "sales_state" VARCHAR(50) NOT NULL DEFAULT 'DISCOVERY',
  ADD COLUMN "conversation_summary" JSONB,
  ADD COLUMN "summary_updated_at" TIMESTAMP(3);
CREATE INDEX "conversations_sales_state_last_message_at_idx" ON "conversations"("sales_state", "last_message_at");
