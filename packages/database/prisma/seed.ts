import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';

loadDotEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

const { prisma } = await import('../src/index.js');

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
    value: 'REPLACE_ME',
    description: 'Placeholder Meta page ID.',
  },
  {
    key: 'delivery_company_id',
    value: 'REPLACE_ME',
    description: 'Placeholder delivery company ID.',
  },
  {
    key: 'utm_source',
    value: 'REPLACE_ME',
    description: 'Placeholder UTM source.',
  },
  {
    key: 'utm_campaign',
    value: 'REPLACE_ME',
    description: 'Placeholder UTM campaign.',
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
    await transaction.knowledgeBase.updateMany({
      where: { isActive: true, version: { not: 1 } },
      data: { isActive: false },
    });

    await transaction.knowledgeBase.upsert({
      where: { version: 1 },
      update: {
        content: 'Sample Alzeena Fashion AI knowledge base. Replace this testing content before production use.',
        isActive: true,
      },
      create: {
        content: 'Sample Alzeena Fashion AI knowledge base. Replace this testing content before production use.',
        version: 1,
        isActive: true,
      },
    });

    for (const setting of settings) {
      await transaction.setting.upsert({
        where: { key: setting.key },
        update: setting,
        create: setting,
      });
    }

    const product = await transaction.product.upsert({
      where: { websiteProductId: 6238 },
      update: {
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
        update: { ...variation, productId: product.id, active: true },
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
