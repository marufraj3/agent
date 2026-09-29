-- Category names are not present in the observed product feed. Keep source IDs
-- normalized without inventing names; names can be filled by a future source.
ALTER TABLE "categories" ALTER COLUMN "name" DROP NOT NULL;
ALTER TABLE "sub_categories" ALTER COLUMN "name" DROP NOT NULL;

-- Preserve the original product_status while separately tracking whether a
-- product was present in the most recent complete feed snapshot.
ALTER TABLE "products"
ADD COLUMN "present_in_feed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "missing_from_feed_at" TIMESTAMP(3);

CREATE INDEX "products_present_in_feed_idx" ON "products"("present_in_feed");

-- Local catalogue search uses case-insensitive contains matching. Trigram GIN
-- indexes avoid full table scans as the catalogue grows.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE INDEX "products_product_name_trgm_idx" ON "products" USING GIN ("product_name" gin_trgm_ops);
CREATE INDEX "products_product_code_trgm_idx" ON "products" USING GIN ("product_code" gin_trgm_ops);
CREATE INDEX "products_slug_trgm_idx" ON "products" USING GIN ("slug" gin_trgm_ops);
