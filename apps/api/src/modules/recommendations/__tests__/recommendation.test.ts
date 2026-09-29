import assert from 'node:assert/strict';
import test from 'node:test';
import { RecommendationService, defaultRecommendationConfig } from '../recommendation.service.js';

class DecimalValue {
  constructor(private readonly value: string) {}
  toString() { return this.value; }
  toFixed(scale = 2) { return Number(this.value).toFixed(scale); }
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111', websiteProductId: 101,
    productName: 'Classic Black Polo', productCode: 'POLO101', categoryName: 'Polo', subCategoryName: 'Classic',
    colorName: 'Black', productDetails: 'Cotton polo', productImage: null, productStatus: '1', presentInFeed: true,
    sellPrice: new DecimalValue('1000'), discountPrice: new DecimalValue('900'), flashSellPrice: null,
    isPreOrder: false, updatedAt: new Date(), variations: [{ websiteVariationId: 1, websiteSizeId: 4, sizeName: 'XL', stockQuantity: 4, active: true }],
    ...overrides,
  };
}
function service(rows: any[], redis?: any, config: any = {}) {
  const prisma = { product: { findMany: async (input: any) => input.select ? rows.map((row) => ({ websiteProductId: row.websiteProductId, productCode: row.productCode })) : rows } };
  return new RecommendationService(prisma as any, redis, { ...defaultRecommendationConfig, ...config });
}

test('recommends by category, effective price, color and available size using database facts', async () => {
  const results = await service([product()]).recommend({ category: 'polo', color: 'black', size: 'XL', maxPrice: 1000 });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.currentPrice, '900.00');
  assert.equal(results[0]?.requestedSize?.availability, 'in_stock');
  assert.ok(results[0]?.reasons.includes('category_match'));
  assert.ok(results[0]?.reasons.includes('price_match'));
  assert.ok(results[0]?.reasons.includes('size_available'));
});

test('does not recommend an unavailable requested size for an ordinary product', async () => {
  const row = product({ variations: [{ websiteVariationId: 1, websiteSizeId: 4, sizeName: 'XL', stockQuantity: 0, active: true }] });
  assert.deepEqual(await service([row]).recommend({ category: 'polo', size: 'XL' }), []);
});

test('allows zero-stock requested size only for a pre-order product', async () => {
  const row = product({ isPreOrder: true, variations: [{ websiteVariationId: 1, websiteSizeId: 4, sizeName: 'XL', stockQuantity: 0, active: true }] });
  const results = await service([row]).recommend({ category: 'polo', size: 'XL' });
  assert.equal(results[0]?.requestedSize?.availability, 'pre_order');
  assert.ok(results[0]?.reasons.includes('pre_order_available'));
});

test('keeps in-budget options before one controlled slightly-above-budget upsell', async () => {
  const rows = [
    product(),
    product({ id: '22222222-2222-4222-8222-222222222222', websiteProductId: 102, productCode: 'POLO102', sellPrice: new DecimalValue('1150'), discountPrice: null }),
  ];
  const results = await service(rows).recommend({ category: 'polo', maxPrice: 1000 });
  assert.equal(results[0]?.productCode, 'POLO101');
  assert.ok(results[1]?.reasons.includes('slightly_above_budget'));
});

test('never returns an invented client price and compares only database products', async () => {
  const rows = [product(), product({ id: '22222222-2222-4222-8222-222222222222', websiteProductId: 102, productCode: 'APL26', productName: 'White Polo' })];
  const compared = await service(rows).compare([101, 102]);
  assert.deepEqual(compared.map((item) => item.currentPrice), ['900.00', '900.00']);
  assert.equal(compared.length, 2);
});

test('uses versioned short-lived Redis cache without changing factual result', async () => {
  const values = new Map<string, string>([['product:cache:version', '7']]);
  let writes = 0;
  const redis = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { writes += 1; values.set(key, value); return 'OK'; },
  };
  const recommendations = service([product()], redis);
  const first = await recommendations.recommend({ category: 'polo' });
  const second = await recommendations.recommend({ category: 'polo' });
  assert.deepEqual(second, first);
  assert.equal(writes, 1);
});
