-- Step 20: structured shopping preferences and reusable conversion events.
ALTER TYPE "CustomerActivityType" ADD VALUE IF NOT EXISTS 'product_searched';
ALTER TYPE "CustomerActivityType" ADD VALUE IF NOT EXISTS 'product_recommended';
ALTER TYPE "CustomerActivityType" ADD VALUE IF NOT EXISTS 'product_added';
ALTER TYPE "CustomerActivityType" ADD VALUE IF NOT EXISTS 'size_checked';
ALTER TYPE "CustomerActivityType" ADD VALUE IF NOT EXISTS 'price_checked';
ALTER TYPE "CustomerActivityType" ADD VALUE IF NOT EXISTS 'abandoned_order';

ALTER TABLE "customers"
  ADD COLUMN "preferred_min_price" DECIMAL(12,2),
  ADD COLUMN "preferred_max_price" DECIMAL(12,2),
  ADD COLUMN "last_shopping_intent" VARCHAR(50),
  ADD COLUMN "preferences_updated_at" TIMESTAMP(3);

ALTER TABLE "customer_activities"
  ADD COLUMN "product_id" UUID,
  ADD COLUMN "requested_size" VARCHAR(50),
  ADD COLUMN "min_price" DECIMAL(12,2),
  ADD COLUMN "max_price" DECIMAL(12,2);

ALTER TABLE "customer_activities"
  ADD CONSTRAINT "customer_activities_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "customer_activities_product_id_type_created_at_idx"
  ON "customer_activities"("product_id", "type", "created_at");
CREATE INDEX "customer_activities_type_created_at_idx"
  ON "customer_activities"("type", "created_at");
CREATE INDEX "customer_activities_requested_size_created_at_idx"
  ON "customer_activities"("requested_size", "created_at");
