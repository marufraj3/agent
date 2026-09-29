-- Step 19 production hardening: price audit and query-pattern indexes.
CREATE TABLE "product_price_history" (
  "id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "old_sell_price" DECIMAL(12,2),
  "new_sell_price" DECIMAL(12,2) NOT NULL,
  "old_discount_price" DECIMAL(12,2),
  "new_discount_price" DECIMAL(12,2),
  "old_flash_price" DECIMAL(12,2),
  "new_flash_price" DECIMAL(12,2),
  "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_price_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_price_history_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_price_history_product_id_changed_at_idx" ON "product_price_history"("product_id", "changed_at");
CREATE INDEX "product_price_history_changed_at_idx" ON "product_price_history"("changed_at");
CREATE INDEX "customers_phone_idx" ON "customers"("phone");
CREATE INDEX "orders_status_updated_at_idx" ON "orders"("status", "updated_at");
CREATE INDEX "messages_role_created_at_idx" ON "messages"("role", "created_at");
