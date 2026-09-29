-- Upgrade structured system event correlation.
ALTER TABLE "system_logs"
  ADD COLUMN "event" VARCHAR(100),
  ADD COLUMN "module" VARCHAR(100),
  ADD COLUMN "request_id" VARCHAR(128),
  ADD COLUMN "conversation_id" UUID,
  ADD COLUMN "customer_id" UUID;

CREATE INDEX "system_logs_event_created_at_idx" ON "system_logs"("event", "created_at");
CREATE INDEX "system_logs_module_created_at_idx" ON "system_logs"("module", "created_at");
CREATE INDEX "system_logs_request_id_idx" ON "system_logs"("request_id");
CREATE INDEX "system_logs_conversation_id_created_at_idx" ON "system_logs"("conversation_id", "created_at");
CREATE INDEX "system_logs_customer_id_created_at_idx" ON "system_logs"("customer_id", "created_at");
