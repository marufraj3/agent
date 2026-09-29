-- Additive search and operational-monitoring indexes for Step 21.
-- pg_trgm supports bounded server-side partial search without full browser-side scans.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "customers_name_idx" ON "customers"("name");
CREATE INDEX IF NOT EXISTS "orders_source_created_at_idx" ON "orders"("source", "created_at");
CREATE INDEX IF NOT EXISTS "customers_name_trgm_idx" ON "customers" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "customers_phone_trgm_idx" ON "customers" USING GIN ("phone" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "products_product_name_trgm_idx" ON "products" USING GIN ("product_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "products_product_code_trgm_idx" ON "products" USING GIN ("product_code" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "orders_order_code_trgm_idx" ON "orders" USING GIN ("order_code" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "orders_external_order_id_trgm_idx" ON "orders" USING GIN ("external_order_id" gin_trgm_ops);
