CREATE TABLE "quick_replies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "title" VARCHAR(120) NOT NULL,
  "message" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "quick_replies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "quick_replies_enabled_sort_order_idx" ON "quick_replies"("enabled", "sort_order");

INSERT INTO "quick_replies" ("title", "message", "sort_order", "updated_at") VALUES
('Greeting', 'আসসালামু আলাইকুম, কীভাবে সাহায্য করতে পারি?', 10, CURRENT_TIMESTAMP),
('Order details', 'আপনার অর্ডারটি কনফার্ম করার জন্য নাম, ফোন নম্বর ও ঠিকানা দিন।', 20, CURRENT_TIMESTAMP),
('Size check', 'আপনার পছন্দের সাইজটি জানালে stock check করে জানাচ্ছি।', 30, CURRENT_TIMESTAMP);
