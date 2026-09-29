import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';

loadDotEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });

const { prisma } = await import('../src/index.js');

async function verify(): Promise<void> {
  const [product, activeKnowledgeBase, settingCount] = await Promise.all([
    prisma.product.findUnique({
      where: { websiteProductId: 6238 },
      include: { variations: { orderBy: { websiteSizeId: 'asc' } } },
    }),
    prisma.knowledgeBase.findFirst({ where: { isActive: true } }),
    prisma.setting.count(),
  ]);

  assert(product, 'Sample product 6238 does not exist.');
  assert.equal(product.isPreOrder, true, 'Sample product must be a pre-order.');
  assert.equal(product.variations.length, 4, 'Sample product must have four variations.');

  const actualStock = Object.fromEntries(
    product.variations.map(({ sizeName, stockQuantity }) => [sizeName, stockQuantity]),
  );
  const expectedStock = { M: 24, L: 22, XL: 16, XXL: 18 } as const;

  for (const [sizeName, stockQuantity] of Object.entries(expectedStock)) {
    assert.equal(actualStock[sizeName], stockQuantity, `Unexpected ${sizeName} stock.`);
  }

  assert(activeKnowledgeBase, 'An active knowledge base must exist.');
  assert(settingCount >= 8, 'Expected at least eight seeded settings.');

  console.log(
    JSON.stringify(
      {
        verified: true,
        product: {
          websiteProductId: product.websiteProductId,
          productName: product.productName,
          isPreOrder: product.isPreOrder,
          variations: product.variations.map(({ sizeName, stockQuantity }) => ({
            sizeName,
            stockQuantity,
          })),
        },
        activeKnowledgeBaseVersion: activeKnowledgeBase.version,
        settingCount,
      },
      null,
      2,
    ),
  );
}

try {
  await verify();
} catch (error) {
  console.error('Database verification failed.', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
