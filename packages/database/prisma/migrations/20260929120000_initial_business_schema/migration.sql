-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL');

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "website_category_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_categories" (
    "id" UUID NOT NULL,
    "website_sub_category_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "category_record_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sub_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "website_product_id" INTEGER NOT NULL,
    "product_name" VARCHAR(255) NOT NULL,
    "product_code" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "product_details" TEXT,
    "product_image" TEXT,
    "website_category_id" INTEGER,
    "category_name" VARCHAR(255),
    "website_sub_category_id" INTEGER,
    "sub_category_name" VARCHAR(255),
    "color_name" VARCHAR(100),
    "product_status" VARCHAR(50) NOT NULL DEFAULT 'active',
    "sell_price" DECIMAL(12,2) NOT NULL,
    "discount_price" DECIMAL(12,2),
    "flash_sell_price" DECIMAL(12,2),
    "is_pre_order" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_synced_at" TIMESTAMP(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "products_sell_price_nonnegative" CHECK ("sell_price" >= 0),
    CONSTRAINT "products_discount_price_nonnegative" CHECK ("discount_price" IS NULL OR "discount_price" >= 0),
    CONSTRAINT "products_flash_sell_price_nonnegative" CHECK ("flash_sell_price" IS NULL OR "flash_sell_price" >= 0)
);

-- CreateTable
CREATE TABLE "product_variations" (
    "id" UUID NOT NULL,
    "website_variation_id" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "website_size_id" INTEGER NOT NULL,
    "size_name" VARCHAR(50) NOT NULL,
    "stock_quantity" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_synced_at" TIMESTAMP(3),

    CONSTRAINT "product_variations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_variations_stock_nonnegative" CHECK ("stock_quantity" >= 0)
);

-- CreateTable
CREATE TABLE "knowledge_bases" (
    "id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "value" TEXT NOT NULL,
    "description" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_logs" (
    "id" UUID NOT NULL,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "type" VARCHAR(100) NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_website_category_id_key" ON "categories"("website_category_id");
CREATE INDEX "categories_name_idx" ON "categories"("name");
CREATE UNIQUE INDEX "sub_categories_website_sub_category_id_key" ON "sub_categories"("website_sub_category_id");
CREATE INDEX "sub_categories_category_record_id_idx" ON "sub_categories"("category_record_id");
CREATE INDEX "sub_categories_name_idx" ON "sub_categories"("name");
CREATE UNIQUE INDEX "products_website_product_id_key" ON "products"("website_product_id");
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");
CREATE INDEX "products_product_code_idx" ON "products"("product_code");
CREATE INDEX "products_product_name_idx" ON "products"("product_name");
CREATE INDEX "products_website_category_id_idx" ON "products"("website_category_id");
CREATE INDEX "products_website_sub_category_id_idx" ON "products"("website_sub_category_id");
CREATE INDEX "products_product_status_idx" ON "products"("product_status");
CREATE INDEX "products_is_pre_order_idx" ON "products"("is_pre_order");
CREATE UNIQUE INDEX "product_variations_website_variation_id_key" ON "product_variations"("website_variation_id");
CREATE INDEX "product_variations_product_id_active_idx" ON "product_variations"("product_id", "active");
CREATE INDEX "product_variations_website_size_id_idx" ON "product_variations"("website_size_id");
CREATE INDEX "product_variations_size_name_idx" ON "product_variations"("size_name");
CREATE INDEX "product_variations_stock_quantity_idx" ON "product_variations"("stock_quantity");
CREATE UNIQUE INDEX "knowledge_bases_version_key" ON "knowledge_bases"("version");
CREATE INDEX "knowledge_bases_is_active_idx" ON "knowledge_bases"("is_active");
-- PostgreSQL partial uniqueness ensures there is at most one main active Knowledge Base.
CREATE UNIQUE INDEX "knowledge_bases_one_active_key" ON "knowledge_bases"("is_active") WHERE "is_active" = true;
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");
CREATE INDEX "system_logs_type_created_at_idx" ON "system_logs"("type", "created_at");
CREATE INDEX "system_logs_level_created_at_idx" ON "system_logs"("level", "created_at");
CREATE INDEX "system_logs_created_at_idx" ON "system_logs"("created_at");

-- AddForeignKey
ALTER TABLE "sub_categories" ADD CONSTRAINT "sub_categories_category_record_id_fkey" FOREIGN KEY ("category_record_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_website_category_id_fkey" FOREIGN KEY ("website_category_id") REFERENCES "categories"("website_category_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_website_sub_category_id_fkey" FOREIGN KEY ("website_sub_category_id") REFERENCES "sub_categories"("website_sub_category_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "product_variations" ADD CONSTRAINT "product_variations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
