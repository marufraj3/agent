import assert from 'node:assert/strict';
import test from 'node:test';
import { CustomerPreferenceService } from '../customer-preference.service.js';
import { SalesEventService } from '../sales-event.service.js';
import { SalesInsightService } from '../sales-insight.service.js';
import { SalesIntelligenceService } from '../sales-intelligence.service.js';
import { ShoppingIntentService } from '../shopping-intent.service.js';

const intents = new ShoppingIntentService();

test('preference memory persists only explicit durable preferences plus last intent', async () => {
  const updates: any[] = [];
  const prisma = { customer: { update: async (input: any) => updates.push(input) } };
  const service = new CustomerPreferenceService(prisma as any);
  await service.rememberExplicit('customer', 'আমি সাধারণত XL পরি', intents.detect('আমি সাধারণত XL পরি'));
  assert.equal(updates[0].data.preferredSize, 'XL');
  await service.rememberExplicit('customer', 'আজকে black দেখান', intents.detect('আজকে black দেখান'));
  assert.equal(updates[1].data.preferredColor, undefined);
  assert.equal(typeof updates[1].data.lastShoppingIntent, 'string');
});

test('sales events strip personal and unknown metadata while retaining analytics dimensions', async () => {
  let created: any;
  const prisma = { customerActivity: { create: async (input: any) => { created = input.data; } } };
  await new SalesEventService(prisma as any).record({
    customerId: 'customer', conversationId: 'conversation', type: 'PRODUCT_SEARCHED', summary: 'search',
    metadata: { size: 'XL', maxPrice: 1000, phone: '01700000000', arbitrary: 'secret' },
  });
  assert.equal(created.requestedSize, 'XL');
  assert.equal(created.maxPrice, 1000);
  assert.equal(created.metadata.phone, undefined);
  assert.equal(created.metadata.arbitrary, undefined);
});

test('sales insight summaries only repeat supplied calculated metrics', () => {
  const result = new SalesInsightService().summarize(
    { recommendationUsage: 10, recommendationToOrder: 2, abandonedOrders: 1 },
    { topSearchedProducts: [{ productCode: 'TX170', searched: 12 }], commonRequestedSizes: [{ size: 'XL', count: 8 }], popularCategories: [{ category: 'Polo', count: 20 }] },
  );
  assert.ok(result.some((line) => line.includes('TX170') && line.includes('12')));
  assert.ok(result.some((line) => line.includes('XL') && line.includes('8')));
  assert.ok(result.every((line) => !line.includes('120')));
});

test('funnel calculation uses only records inside the supplied date filter', async () => {
  const seen: any[] = [];
  const prisma = {
    conversation: { count: async (input: any) => { seen.push(input.where.createdAt); return 5; } },
    customerActivity: { groupBy: async () => [
      { type: 'PRODUCT_SEARCHED', _count: { _all: 4 } },
      { type: 'ORDER_STARTED', _count: { _all: 2 } },
      { type: 'ABANDONED_ORDER', _count: { _all: 1 } },
    ] },
    order: { count: async () => 1 },
  };
  const from = new Date('2026-09-01T00:00:00Z'); const to = new Date('2026-10-01T00:00:00Z');
  const funnel = await new SalesIntelligenceService(prisma as any).funnel({ from, to });
  assert.equal(funnel.conversationsStarted, 5);
  assert.equal(funnel.productSearches, 4);
  assert.equal(funnel.orderStarts, 2);
  assert.equal(funnel.abandonedOrders, 1);
  assert.deepEqual(seen[0], { gte: from, lt: to });
});

test('product performance combines event metrics, orders, current DB price and stock', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const prisma = {
    customerActivity: { groupBy: async () => [{ productId: id, type: 'PRODUCT_RECOMMENDED', _count: { _all: 3 } }] },
    orderItem: { groupBy: async () => [{ productId: id, _sum: { quantity: 2 }, _count: { orderId: 1 } }] },
    product: { findMany: async () => [{ id, websiteProductId: 10, productName: 'Polo', productCode: 'P10', categoryName: 'Polo', sellPrice: 1000, discountPrice: 900, flashSellPrice: null, isPreOrder: false, variations: [{ stockQuantity: 7 }] }] },
  };
  const result = await new SalesIntelligenceService(prisma as any).productPerformance({ from: new Date(0), to: new Date() });
  assert.equal(result.items[0].recommended, 3);
  assert.equal(result.items[0].orderQuantity, 2);
  assert.equal(result.items[0].currentStock, 7);
  assert.equal(result.items[0].currentPrice, '900.00');
});
