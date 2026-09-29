-- CreateEnum
CREATE TYPE "ConversationChannel" AS ENUM ('web', 'messenger', 'admin', 'test');
CREATE TYPE "ConversationStatus" AS ENUM ('active', 'closed', 'human');
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant', 'system', 'human');
CREATE TYPE "MessageType" AS ENUM ('text', 'image', 'audio', 'system');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "external_id" VARCHAR(255),
    "name" VARCHAR(255),
    "phone" VARCHAR(50),
    "email" VARCHAR(320),
    "platform" VARCHAR(50),
    "platform_user_id" VARCHAR(255),
    "language" VARCHAR(20),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "channel" "ConversationChannel" NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'active',
    "title" VARCHAR(255),
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "customer_id" UUID,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "message_type" "MessageType" NOT NULL DEFAULT 'text',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- Unique constraints and indexes
CREATE UNIQUE INDEX "customers_external_id_key" ON "customers"("external_id");
CREATE UNIQUE INDEX "customers_platform_platform_user_id_key" ON "customers"("platform", "platform_user_id");
CREATE INDEX "customers_platform_user_id_idx" ON "customers"("platform_user_id");
CREATE INDEX "customers_created_at_idx" ON "customers"("created_at");
CREATE INDEX "conversations_customer_id_status_last_message_at_idx" ON "conversations"("customer_id", "status", "last_message_at");
CREATE INDEX "conversations_channel_status_last_message_at_idx" ON "conversations"("channel", "status", "last_message_at");
CREATE INDEX "conversations_last_message_at_idx" ON "conversations"("last_message_at");
-- At most one active conversation per customer/channel, while preserving closed history.
CREATE UNIQUE INDEX "conversations_one_active_customer_channel_key"
ON "conversations"("customer_id", "channel") WHERE "status" = 'active';
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");
CREATE INDEX "messages_customer_id_created_at_idx" ON "messages"("customer_id", "created_at");
CREATE INDEX "messages_created_at_idx" ON "messages"("created_at");

-- Foreign keys
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_fkey"
FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey"
FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_customer_id_fkey"
FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
