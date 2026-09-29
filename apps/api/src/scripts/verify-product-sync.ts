import assert from 'node:assert/strict';
import { prisma } from '@alzeena/database';
import pino from 'pino';
import { env } from '../config/env.js';
import { ProductCatalogService } from '../modules/products/product-catalog.service.js';
import { createProductFeedClient } from '../modules/products/product-feed.factory.js';
import { ProductSyncService } from '../modules/products/product-sync.service.js';

const logger = pino({ level: env.LOG_LEVEL });

async function runSync() {
  const service = new ProductSyncService({
    prisma,
    logger,
    feedClient: createProductFeedClient((details) => logger.warn(details, 'Retrying feed request')),
  });
  return service.synchronize();
}

async function verify(): Promise<void> {
  const firstSync = await runSync();

  // Prove that the second upsert replaces stale local stock rather than duplicating data.
  await prisma.productVariation.update({
    where: { websiteVariationId: 41375 },
    data: { stockQuantity: 999 },
  });
  const secondSync = await runSync();

  const product = await prisma.product.findUnique({
    where: { websiteProductId: 6238 },
    include: { variations: true },
  });
  assert(product, 'Product 6238 was not synchronized.');
  assert.equal(product.isPreOrder, true);
  assert.equal(product.variations.length, 4, 'Product 6238 must have exactly four variations.');

  const expectedStock = { M: 24, L: 22, XL: 16, XXL: 18 } as const;
  const actualStock = Object.fromEntries(
    product.variations.map((variation) => [variation.sizeName, variation.stockQuantity]),
  );
  for (const [size, stock] of Object.entries(expectedStock)) {
    assert.equal(actualStock[size], stock, `${size} stock did not match the live feed expectation.`);
  }

  assert.equal(await prisma.product.count({ where: { websiteProductId: 6238 } }), 1);
  for (const websiteVariationId of [41375, 41376, 41377, 41378]) {
    assert.equal(await prisma.productVariation.count({ where: { websiteVariationId } }), 1);
  }

  const catalog = new ProductCatalogService(prisma);
  const tx170Results = await catalog.searchProducts('TX170');
  const argentinaResults = await catalog.searchProducts('Argentina');
  assert(tx170Results.some((item) => item.id === 6238), 'TX170 local search did not return 6238.');
  assert(
    argentinaResults.some((item) => item.id === 6238),
    'Argentina local search did not return 6238.',
  );

  let zeroStockAvailability: Awaited<
    ReturnType<ProductCatalogService['getProductAvailability']>
  >;
  try {
    await prisma.productVariation.update({
      where: { websiteVariationId: 41375 },
      data: { stockQuantity: 0 },
    });
    zeroStockAvailability = await catalog.getProductAvailability(6238);
    assert(zeroStockAvailability, 'Product availability was not returned.');
    assert.equal(
      zeroStockAvailability.sizes.find((size) => size.sizeName === 'M')?.orderable,
      true,
      'A zero-stock pre-order size must remain orderable.',
    );
  } finally {
    await prisma.productVariation.update({
      where: { websiteVariationId: 41375 },
      data: { stockQuantity: expectedStock.M },
    });
  }
  const availability = await catalog.getProductAvailability(6238);

  console.log(
    JSON.stringify(
      {
        verified: true,
        firstSync,
        secondSync,
        product6238: {
          variationCount: product.variations.length,
          stock: actualStock,
          isPreOrder: product.isPreOrder,
        },
        searches: { TX170: tx170Results.length, Argentina: argentinaResults.length },
        availability,
      },
      null,
      2,
    ),
  );
}

try {
  await verify();
} catch (error) {
  logger.error({ err: error }, 'Product sync verification failed');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
