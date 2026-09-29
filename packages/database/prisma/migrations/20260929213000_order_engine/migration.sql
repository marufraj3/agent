-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('draft', 'awaiting_information', 'awaiting_confirmation', 'confirmed', 'submitted', 'completed', 'failed', 'cancelled');
CREATE TYPE "OrderConfirmationStatus" AS ENUM ('pending', 'confirmed', 'rejected');
CREATE TYPE "OrderSource" AS ENUM ('ai', 'test', 'messenger', 'web');
CREATE TYPE "DeliveryLocation" AS ENUM ('dhaka', 'outside_dhaka');
CREATE TYPE "OrderSubmissionResult" AS ENUM ('not_attempted', 'in_progress', 'succeeded', 'known_failure', 'unknown');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN "address" TEXT;

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_code" VARCHAR(100),
    "customer_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'draft',
    "confirmation_status" "OrderConfirmationStatus" NOT NULL DEFAULT 'pending',
    "confirmation_text" VARCHAR(100),
    "confirmed_at" TIMESTAMP(3),
    "source" "OrderSource" NOT NULL DEFAULT 'ai',
    "delivery_location" "DeliveryLocation",
    "total_quantity" INTEGER NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "delivery_charge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'BDT',
    "external_order_id" VARCHAR(255),
    "external_response" JSONB,
    "customer_snapshot" JSONB NOT NULL,
    "draft_context" JSONB,
    "submission_reference" UUID NOT NULL,
    "submission_result" "OrderSubmissionResult" NOT NULL DEFAULT 'not_attempted',
    "submission_attempted_at" TIMESTAMP(3),
    "failure_code" VARCHAR(100),
    "failure_message" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variation_id" UUID NOT NULL,
    "website_product_id" INTEGER NOT NULL,
    "website_variation_id" INTEGER NOT NULL,
    "product_name" VARCHAR(255) NOT NULL,
    "product_code" VARCHAR(100) NOT NULL,
    "variation_size" VARCHAR(50) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "line_total" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- Constraints and indexes
CREATE UNIQUE INDEX "orders_external_order_id_key" ON "orders"("external_order_id");
CREATE UNIQUE INDEX "orders_submission_reference_key" ON "orders"("submission_reference");
CREATE INDEX "orders_customer_id_created_at_idx" ON "orders"("customer_id", "created_at");
CREATE INDEX "orders_conversation_id_status_updated_at_idx" ON "orders"("conversation_id", "status", "updated_at");
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");
CREATE INDEX "orders_submission_result_updated_at_idx" ON "orders"("submission_result", "updated_at");
CREATE UNIQUE INDEX "orders_one_active_conversation_key" ON "orders"("conversation_id")
WHERE "status" IN ('draft', 'awaiting_information', 'awaiting_confirmation', 'confirmed');
CREATE UNIQUE INDEX "order_items_order_id_variation_id_key" ON "order_items"("order_id", "variation_id");
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");
CREATE INDEX "order_items_variation_id_idx" ON "order_items"("variation_id");
CREATE INDEX "order_items_website_product_id_idx" ON "order_items"("website_product_id");

-- Foreign keys
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variation_id_fkey" FOREIGN KEY ("variation_id") REFERENCES "product_variations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
