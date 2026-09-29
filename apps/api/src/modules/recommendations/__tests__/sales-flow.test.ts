import assert from 'node:assert/strict';
import test from 'node:test';
import { RecommendationService, defaultRecommendationConfig } from '../recommendation.service.js';
import { ShoppingIntentService } from '../../sales-intelligence/shopping-intent.service.js';

class DecimalValue { constructor(private value: string) {} toString() { return this.value; } }
const rows = [
  { id: '11111111-1111-4111-8111-111111111111', websiteProductId: 1, productName: 'Black Polo', productCode: 'BP1', categoryName: 'Polo', subCategoryName: null, colorName: 'Black', productDetails: 'Cotton', productImage: null, productStatus: '1', presentInFeed: true, sellPrice: new DecimalValue('950'), discountPrice: null, flashSellPrice: null, isPreOrder: false, variations: [{ sizeName: 'XL', stockQuantity: 2, active: true }] },
  { id: '22222222-2222-4222-8222-222222222222', websiteProductId: 2, productName: 'Navy Polo', productCode: 'NP2', categoryName: 'Polo', subCategoryName: null, colorName: 'Navy', productDetails: 'Cotton', productImage: null, productStatus: '1', presentInFeed: true, sellPrice: new DecimalValue('990'), discountPrice: null, flashSellPrice: null, isPreOrder: false, variations: [{ sizeName: 'XL', stockQuantity: 3, active: true }] },
];

test('local sales flow keeps budget/category context, verifies size/color, supports similar, then yields to order intent', async () => {
  const intents = new ShoppingIntentService();
  const first = intents.detect('ভাই ১০০০ টাকার মধ্যে একটা polo দেখান');
  const prisma = { product: { findMany: async () => rows } };
  const recommendations = new RecommendationService(prisma as any, undefined, defaultRecommendationConfig);
  const initial = await recommendations.recommend(first.filters);
  assert.equal(initial.length, 2);
  assert.ok(initial.every((item) => Number(item.currentPrice) <= 1000));

  const refined = intents.detect('কালো আর XL আছে?', { previousCategory: 'polo', previousMaxPrice: 1000 });
  const filtered = await recommendations.recommend(refined.filters);
  assert.equal(filtered[0]?.productCode, 'BP1');
  assert.equal(filtered[0]?.requestedSize?.orderable, true);

  const similar = intents.detect('এইটার মতো আর একটা দেখান', { previousCategory: 'polo', previousSize: 'XL', previousMaxPrice: 1000 });
  assert.equal(similar.primary, 'product_search');
  const ready = intents.detect('ঠিক আছে এটা নেব');
  assert.equal(ready.primary, 'ready_to_order');
});
