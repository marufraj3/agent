import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';

loadDotEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

const { prisma } = await import('../src/index.js');

const previousSampleKnowledgeBase =
  'Sample Alzeena Fashion AI knowledge base. Replace this testing content before production use.';

const starterKnowledgeBase = `AI PERSONA:
You are Alzeena Fashion's professional sales assistant.

Your job is to help customers find products, answer questions and guide them through ordering.

LANGUAGE:

* Reply in the same language style used by the customer.
* Use natural Bangla/Banglish when appropriate.
* Keep replies concise and easy to understand.
* Do not sound robotic.

PRODUCT RULES:

* Never invent a product.
* Never guess a price.
* Never guess stock.
* Never guess size availability.
* Use the product database for product information.

PRE-ORDER:

* If isPreOrder is true, a product may be ordered even when stock is 0.
* If isPreOrder is false and stock is 0, it is unavailable.
* Follow backend availability results.

SALES:

* Understand the customer's requirement.
* Recommend relevant available products.
* Provide accurate information.
* Help the customer complete an order when they are ready.

ORDER:
Before order creation, collect:

* Name
* Phone
* Full address
* Product
* Size
* Quantity

Always show an order summary and ask for final confirmation before creating an order.

IMPORTANT:
Never fabricate information.
If you do not know something, do not guess.
Ask for clarification or request human assistance.

DELIVERY:
Delivery charges are provided by the backend settings.
Do not invent delivery charges.

RETURN:
[Admin: Write return policy here]

FAQ:
[Admin: Add frequently asked questions here]

HUMAN HANDOVER:
If you cannot confidently answer an important customer question, do not guess. Mark the conversation for human assistance.`;

const settings = [
  {
    key: 'delivery_charge_dhaka',
    value: '0',
    description: 'Placeholder Dhaka delivery charge in BDT; configure before use.',
  },
  {
    key: 'delivery_charge_outside_dhaka',
    value: '0',
    description: 'Placeholder outside-Dhaka delivery charge in BDT; configure before use.',
  },
  {
    key: 'return_delivery_charge',
    value: '0',
    description: 'Placeholder return delivery charge in BDT; configure before use.',
  },
  {
    key: 'website_api_base_url',
    value: 'https://sells.alzeena.com.bd/public/api',
    description: 'Public website API base URL; not called by this seed.',
  },
  {
    key: 'page_id',
    value: '3',
    description: 'Alzeena page ID.',
  },
  {
    key: 'delivery_company_id',
    value: '11',
    description: 'Delivery company ID.',
  },
  {
    key: 'utm_source',
    value: 'AI',
    description: 'Order attribution UTM source.',
  },
  {
    key: 'utm_campaign',
    value: 'Order From AI BOT',
    description: 'Order attribution UTM campaign.',
  },
] as const;

const variations = [
  { websiteVariationId: 41375, websiteSizeId: 2, sizeName: 'M', stockQuantity: 24 },
  { websiteVariationId: 41376, websiteSizeId: 3, sizeName: 'L', stockQuantity: 22 },
  { websiteVariationId: 41377, websiteSizeId: 4, sizeName: 'XL', stockQuantity: 16 },
  { websiteVariationId: 41378, websiteSizeId: 5, sizeName: 'XXL', stockQuantity: 18 },
] as const;

async function seed(): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const activeKnowledgeBase = await transaction.knowledgeBase.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    });

    if (!activeKnowledgeBase) {
      const latest = await transaction.knowledgeBase.aggregate({ _max: { version: true } });
      await transaction.knowledgeBase.create({
        data: {
          content: starterKnowledgeBase,
          version: (latest._max.version ?? 0) + 1,
          isActive: true,
        },
      });
    } else if (activeKnowledgeBase.content === previousSampleKnowledgeBase) {
      // Upgrade only the exact Step 2 placeholder. Never overwrite admin-authored content.
      await transaction.knowledgeBase.update({
        where: { id: activeKnowledgeBase.id },
        data: { content: starterKnowledgeBase },
      });
    }

    for (const setting of settings) {
      await transaction.setting.upsert({
        where: { key: setting.key },
        update: { description: setting.description },
        create: setting,
      });
    }

    const knownPlaceholderValues = [
      { key: 'page_id', value: '3' },
      { key: 'delivery_company_id', value: '11' },
      { key: 'utm_source', value: 'AI' },
      { key: 'utm_campaign', value: 'Order From AI BOT' },
    ];
    for (const setting of knownPlaceholderValues) {
      await transaction.setting.updateMany({
        where: { key: setting.key, value: 'REPLACE_ME' },
        data: { value: setting.value },
      });
    }

    const product = await transaction.product.upsert({
      where: { websiteProductId: 6238 },
      // Never overwrite product-feed values when the seed is run after synchronization.
      update: {},
      create: {
        websiteProductId: 6238,
        productName: 'TX170 Messi Fan Edition Polo',
        productCode: 'TX170 Argentina',
        slug: 'tx170-messi-fan-edition-polo',
        productDetails: 'Sample product created by the Step 2 database seed.',
        productStatus: 'active',
        sellPrice: '1250.00',
        discountPrice: '990.00',
        flashSellPrice: '0.00',
        isPreOrder: true,
      },
    });

    for (const variation of variations) {
      await transaction.productVariation.upsert({
        where: { websiteVariationId: variation.websiteVariationId },
        update: {},
        create: { ...variation, productId: product.id, active: true },
      });
    }
  });
}

try {
  await seed();
  console.log('Database seed completed successfully.');
} catch (error) {
  console.error('Database seed failed.', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
