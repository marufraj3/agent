import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@alzeena/database';
import { OrderConversationService } from '../order-conversation.service.js';
import { OrderService } from '../order.service.js';
import { OrderEngineError } from '../order.types.js';
import { getEffectiveProductPrice, money, normalizeBangladeshPhone } from '../order-utils.js';
import { WebsiteOrderApiClient, WebsiteOrderApiError } from '../website-order-api.client.js';

const settings = {
  deliveryChargeDhaka: '70', deliveryChargeOutsideDhaka: '130', returnDeliveryCharge: '0',
  websiteApiBaseUrl: 'https://example.test/api', pageId: '3', deliveryCompanyId: '11',
  utmSource: 'AI', utmCampaign: 'Order From AI BOT',
};
const submission = {
  submissionReference: '780688af-f71b-46b9-bde3-e1a0778cb5a6', totalQuantity: 2,
  subtotal: '1980.00', deliveryCharge: '70.00',
  customer: { name: 'Customer', phone: '01712345678', address: 'Dhaka' },
  items: [{ quantity: 2, unitPrice: '990.00', lineTotal: '1980.00', websiteProductId: 6238, websiteVariationId: 99, variationSize: 'M' }],
};
function response(body: unknown, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Phone and money are pure backend rules and never delegated to the model or browser.
test('normalizes local Bangladesh phone numbers', () => assert.equal(normalizeBangladeshPhone('01712-345678'), '01712345678'));
test('normalizes +880 Bangladesh phone numbers', () => assert.equal(normalizeBangladeshPhone('+880 1712 345678'), '01712345678'));
test('normalizes 880 Bangladesh phone numbers', () => assert.equal(normalizeBangladeshPhone('8801712345678'), '01712345678'));
test('rejects malformed Bangladesh phone numbers', () => assert.throws(() => normalizeBangladeshPhone('12345'), /valid Bangladesh/i));
test('rejects invalid Bangladesh operator prefixes', () => assert.throws(() => normalizeBangladeshPhone('01112345678'), /valid Bangladesh/i));
test('rounds monetary values safely to two decimal places', () => assert.equal(money('10.125').toFixed(2), '10.13'));
test('effective pricing prefers flash sale price', () => assert.equal(getEffectiveProductPrice({ sellPrice: new Prisma.Decimal(1200), discountPrice: new Prisma.Decimal(1000), flashSellPrice: new Prisma.Decimal(900) }).toFixed(), '900'));
test('effective pricing prefers discount price when no flash price exists', () => assert.equal(getEffectiveProductPrice({ sellPrice: new Prisma.Decimal(1200), discountPrice: new Prisma.Decimal(1000), flashSellPrice: null }).toFixed(), '1000'));
test('effective pricing falls back to sell price', () => assert.equal(getEffectiveProductPrice({ sellPrice: new Prisma.Decimal(1200), discountPrice: null, flashSellPrice: null }).toFixed(), '1200'));

test('website payload uses actual product and variation IDs and configured attribution', () => {
  const client = new WebsiteOrderApiClient(1000);
  const payload = client.buildPayload(submission, settings);
  assert.equal(payload.order_details[0]?.options.product_id, 6238);
  assert.equal(payload.order_details[0]?.options.product_size_id, 99);
  assert.equal(payload.order_additional.page_id, 3);
  assert.equal(payload.order_additional.utm_campaign, 'Order From AI BOT');
});
test('website payload sends server-calculated quantities, prices, and delivery charge', () => {
  const payload = new WebsiteOrderApiClient(1000).buildPayload(submission, settings);
  assert.equal(payload.count, 2); assert.equal(payload.subtotal, 1980); assert.equal(payload.order_additional.delivery_charge_location, 70);
});
test('website payload uses required phone password without logging credentials', () => {
  const payload = new WebsiteOrderApiClient(1000).buildPayload(submission, settings);
  assert.equal(payload.order_additional.password, '01712345678');
  assert.equal('authorization' in payload.order_additional, false);
});
test('website client maps status 200 and code[0] to external ID', async () => {
  const client = new WebsiteOrderApiClient(1000, async () => response({ status: 200, code: ['ORDER-9'], message: 'ok' }));
  const result = await client.submit(submission, settings); assert.equal(result.orderId, 'ORDER-9');
});
test('website client accepts numeric external IDs', async () => {
  const client = new WebsiteOrderApiClient(1000, async () => response({ status: '200', code: [987] }));
  assert.equal((await client.submit(submission, settings)).orderId, '987');
});
test('website client classifies HTTP 422 as a safely known failure', async () => {
  const client = new WebsiteOrderApiClient(1000, async () => response({ message: 'invalid' }, 422));
  await assert.rejects(() => client.submit(submission, settings), (error: unknown) => error instanceof WebsiteOrderApiError && error.outcomeKnown && error.code === 'HTTP_422');
});
test('website client classifies HTTP 500 as an unknown outcome', async () => {
  const client = new WebsiteOrderApiClient(1000, async () => response({ message: 'error' }, 500));
  await assert.rejects(() => client.submit(submission, settings), (error: unknown) => error instanceof WebsiteOrderApiError && !error.outcomeKnown && error.code === 'HTTP_500');
});
test('website client classifies malformed success responses as unknown', async () => {
  const client = new WebsiteOrderApiClient(1000, async () => response('not-json'));
  await assert.rejects(() => client.submit(submission, settings), (error: unknown) => error instanceof WebsiteOrderApiError && !error.outcomeKnown && error.code === 'MALFORMED_RESPONSE');
});
test('website client classifies a success response missing its external ID as unknown', async () => {
  const client = new WebsiteOrderApiClient(1000, async () => response({ status: 200, code: [] }));
  await assert.rejects(() => client.submit(submission, settings), (error: unknown) => error instanceof WebsiteOrderApiError && !error.outcomeKnown && error.code === 'MALFORMED_RESPONSE');
});
test('website client classifies network errors as unknown', async () => {
  const client = new WebsiteOrderApiClient(1000, async () => { throw new Error('offline'); });
  await assert.rejects(() => client.submit(submission, settings), (error: unknown) => error instanceof WebsiteOrderApiError && !error.outcomeKnown && error.code === 'NETWORK_ERROR');
});
test('website client classifies timeout as unknown and never retries', async () => {
  let attempts = 0;
  const client = new WebsiteOrderApiClient(5, (_url, init) => new Promise((_resolve, reject) => {
    attempts += 1; init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  await assert.rejects(() => client.submit(submission, settings), (error: unknown) => error instanceof WebsiteOrderApiError && error.code === 'TIMEOUT');
  assert.equal(attempts, 1);
});
test('website client posts once to the configured order endpoint with submission reference', async () => {
  let url = ''; let headers: HeadersInit | undefined;
  const client = new WebsiteOrderApiClient(1000, async (input, init) => { url = String(input); headers = init?.headers; return response({ status: 200, code: ['A'] }); });
  await client.submit(submission, settings);
  assert.equal(url, 'https://example.test/api/page/order/request');
  assert.equal((headers as Record<string, string>)['x-submission-reference'], submission.submissionReference);
});

function conversationOrders(overrides: Record<string, unknown> = {}) {
  return {
    getActiveOrderForConversation: async () => null,
    createDraftOrder: async () => ({ id: 'order-1', draftContext: {}, status: 'DRAFT', items: [] }),
    getOrder: async () => ({ id: 'order-1', draftContext: {}, status: 'DRAFT', items: [] }),
    validateOrder: async () => [{ code: 'MISSING_NAME', message: 'name' }],
    updateDraftContext: async () => undefined,
    addOrderItem: async () => undefined,
    updateCustomerInformation: async () => undefined,
    setDeliveryLocation: async () => undefined,
    cancelOrder: async () => undefined,
    requestConfirmation: async () => undefined,
    confirmOrder: async () => undefined,
    submitOrder: async () => undefined,
    ...overrides,
  };
}
const input = { message: 'M size order', conversationId: 'conversation-1', customer: { id: 'customer-1', name: null, phone: null }, productIds: [6238] };

test('broad order intent without a resolved product and size does not create a draft', async () => {
  let created = false;
  const service = new OrderConversationService(conversationOrders({ createDraftOrder: async () => { created = true; } }) as never);
  assert.equal(await service.handle({ ...input, message: 'একটা চাই', productIds: [6238] }), null); assert.equal(created, false);
});
test('resolved image product context can seed a validated draft', async () => {
  let websiteProductId = 0;
  const service = new OrderConversationService(conversationOrders({ addOrderItem: async (_id: string, item: { websiteProductId: number }) => { websiteProductId = item.websiteProductId; } }) as never);
  const result = await service.handle({ ...input, message: 'এই ছবিরটা M size order' }); assert.equal(websiteProductId, 6238); assert.equal(result?.orderAction.orderId, 'order-1');
});
test('resolved voice product context can seed a validated draft', async () => {
  let size = '';
  const service = new OrderConversationService(conversationOrders({ addOrderItem: async (_id: string, item: { size: string }) => { size = item.size; } }) as never);
  await service.handle({ ...input, message: 'TX170 M size অর্ডার' }); assert.equal(size, 'M');
});
test('order conversation asks only for the first missing customer field', async () => {
  const service = new OrderConversationService(conversationOrders() as never);
  const result = await service.handle(input); assert.match(result?.reply ?? '', /নাম/); assert.equal(result?.orderAction.type, 'create_order');
});
test('short confirmation is accepted only while awaiting confirmation', async () => {
  let confirmed = false;
  const awaiting = { id: 'order-1', status: 'AWAITING_CONFIRMATION', confirmationStatus: 'PENDING', draftContext: {}, items: [] };
  const service = new OrderConversationService(conversationOrders({ getActiveOrderForConversation: async () => awaiting, confirmOrder: async () => { confirmed = true; }, submitOrder: async () => ({ externalOrderId: 'EXT-1' }) }) as never);
  const result = await service.handle({ ...input, message: 'জি', productIds: [] }); assert.equal(confirmed, true); assert.match(result?.reply ?? '', /EXT-1/);
});
test('broad “দেন” is not treated as final explicit confirmation', async () => {
  let confirmed = false;
  const awaiting = { id: 'order-1', status: 'AWAITING_CONFIRMATION', confirmationStatus: 'PENDING', draftContext: {}, items: [] };
  const service = new OrderConversationService(conversationOrders({ getActiveOrderForConversation: async () => awaiting, confirmOrder: async () => { confirmed = true; } }) as never);
  const result = await service.handle({ ...input, message: 'দেন', productIds: [] }); assert.equal(confirmed, false); assert.match(result?.reply ?? '', /জি/);
});
test('customer can cancel an awaiting confirmation', async () => {
  let cancelled = false;
  const awaiting = { id: 'order-1', status: 'AWAITING_CONFIRMATION', confirmationStatus: 'PENDING', draftContext: {}, items: [] };
  const service = new OrderConversationService(conversationOrders({ getActiveOrderForConversation: async () => awaiting, cancelOrder: async () => { cancelled = true; } }) as never);
  const result = await service.handle({ ...input, message: 'cancel', productIds: [] }); assert.equal(cancelled, true); assert.equal(result?.orderAction.type, 'cancel_order');
});

test('order state machine rejects invalid terminal transitions', async () => {
  const db = { order: { findUnique: async () => ({ id: 'o', status: 'COMPLETED' }), update: async () => assert.fail('must not update') } };
  const service = new OrderService(db as never, new WebsiteOrderApiClient(100));
  await assert.rejects(() => service.transitionOrder('o', 'DRAFT'), (error: unknown) => error instanceof OrderEngineError && error.code === 'INVALID_ORDER_TRANSITION');
});
test('admin retry is blocked for unknown external outcomes', async () => {
  const db = { order: { findUnique: async () => ({ id: 'o', status: 'FAILED', submissionResult: 'UNKNOWN', items: [] }) } };
  const service = new OrderService(db as never, new WebsiteOrderApiClient(100));
  await assert.rejects(() => service.retryOrderSubmission('o'), (error: unknown) => error instanceof OrderEngineError && error.code === 'ORDER_RETRY_NOT_SAFE');
});
test('submission requires persisted explicit confirmation', async () => {
  const db = { order: { findUnique: async () => ({ id: 'o', status: 'AWAITING_CONFIRMATION', confirmationStatus: 'PENDING', items: [] }) } };
  const service = new OrderService(db as never, new WebsiteOrderApiClient(100));
  await assert.rejects(() => service.submitOrder('o'), (error: unknown) => error instanceof OrderEngineError && error.code === 'ORDER_NOT_CONFIRMED');
});
test('duplicate submission claims are rejected before any external call', async () => {
  let externalCalls = 0;
  const claimedOrder = { ...validOrder, id: 'o' };
  const db = {
    order: { findUnique: async () => claimedOrder, updateMany: async () => ({ count: 0 }) },
    product: { findUnique: async () => currentProduct },
  };
  const client = new WebsiteOrderApiClient(100, async () => { externalCalls += 1; return response({ status: 200, code: ['x'] }); });
  const service = new OrderService(db as never, client);
  await assert.rejects(() => service.submitOrder('o'), (error: unknown) => error instanceof OrderEngineError && error.code === 'DUPLICATE_SUBMISSION'); assert.equal(externalCalls, 0);
});

const currentProduct = {
  id: 'product-uuid', websiteProductId: 6238, productName: 'Messi Polo', productCode: 'TX170',
  sellPrice: new Prisma.Decimal(1250), discountPrice: new Prisma.Decimal(990), flashSellPrice: null,
  presentInFeed: true, productStatus: '1', isPreOrder: false,
  variations: [{ id: 'variation-uuid', websiteVariationId: 99, sizeName: 'M', stockQuantity: 5, active: true }],
};
const validOrder = {
  id: 'order-uuid', customerId: 'customer-uuid', conversationId: 'conversation-uuid', status: 'CONFIRMED',
  confirmationStatus: 'CONFIRMED', submissionResult: 'NOT_ATTEMPTED',
  submissionReference: submission.submissionReference, deliveryLocation: 'DHAKA', totalQuantity: 2,
  subtotal: new Prisma.Decimal(1980), deliveryCharge: new Prisma.Decimal(70), totalAmount: new Prisma.Decimal(2050),
  customerSnapshot: { name: 'Customer', phone: '01712345678', address: 'Dhaka' },
  items: [{ id: 'item-uuid', productId: 'product-uuid', variationId: 'variation-uuid', websiteProductId: 6238, websiteVariationId: 99, productName: 'Messi Polo', productCode: 'TX170', variationSize: 'M', quantity: 2, unitPrice: new Prisma.Decimal(990), lineTotal: new Prisma.Decimal(1980) }],
};

test('creates an internal draft with a historical customer snapshot', async () => {
  let created: Record<string, unknown> | undefined;
  const tx = { order: { create: async ({ data }: any) => { created = data; return { id: 'o', source: 'AI', items: [], ...data }; } }, systemLog: { create: async () => ({}) } };
  const db = { customer: { findUnique: async () => ({ id: 'c', name: 'Rahim', phone: '01712345678', address: 'Dhaka' }) }, order: { findFirst: async () => null }, $transaction: async (callback: any) => callback(tx) };
  const service = new OrderService(db as never, new WebsiteOrderApiClient(100));
  await service.createDraftOrder({ customerId: 'c', conversationId: 'v' });
  assert.deepEqual(created?.customerSnapshot, { name: 'Rahim', phone: '01712345678', address: 'Dhaka' });
});

test('queries orders by external website ID with complete relations', async () => {
  let query: unknown;
  const db = { order: { findUnique: async (input: unknown) => { query = input; return validOrder; } } };
  const service = new OrderService(db as never, new WebsiteOrderApiClient(100));
  assert.equal((await service.getOrderByExternalId('EXT-77')).id, 'order-uuid');
  assert.deepEqual((query as any).where, { externalOrderId: 'EXT-77' });
});

test('normal zero-stock items are rejected by the order stock rule', () => {
  const service = new OrderService({} as never, new WebsiteOrderApiClient(100));
  assert.throws(() => (service as any).assertStock({ presentInFeed: true, productStatus: '1', isPreOrder: false }, { active: true, stockQuantity: 0 }, 1), /unavailable/i);
});

test('active zero-stock pre-order items are allowed by the order stock rule', () => {
  const service = new OrderService({} as never, new WebsiteOrderApiClient(100));
  assert.doesNotThrow(() => (service as any).assertStock({ presentInFeed: true, productStatus: '1', isPreOrder: true }, { active: true, stockQuantity: 0 }, 2));
});

test('normal item quantities above current stock are rejected', () => {
  const service = new OrderService({} as never, new WebsiteOrderApiClient(100));
  assert.throws(() => (service as any).assertStock({ presentInFeed: true, productStatus: '1', isPreOrder: false }, { active: true, stockQuantity: 2 }, 3), /exceeds/i);
});

test('calculates multi-item quantity, subtotal, delivery, and total server-side', async () => {
  let totals: any;
  const tx = {
    order: {
      findUnique: async () => ({ deliveryLocation: 'OUTSIDE_DHAKA', items: [
        { quantity: 2, lineTotal: new Prisma.Decimal('1980.00') },
        { quantity: 1, lineTotal: new Prisma.Decimal('500.00') },
      ] }),
      update: async ({ data }: any) => { totals = data; return data; },
    },
  };
  const service = new OrderService({} as never, new WebsiteOrderApiClient(100));
  await (service as any).calculateOrderInTransaction(tx, 'o', settings);
  assert.equal(totals.totalQuantity, 3); assert.equal(totals.subtotal.toFixed(2), '2480.00');
  assert.equal(totals.deliveryCharge.toFixed(2), '130.00'); assert.equal(totals.totalAmount.toFixed(2), '2610.00');
});

test('safe admin retry revalidates and persists the mapped external order ID', async () => {
  let persisted: any;
  const retryOrder = { ...validOrder, status: 'FAILED', submissionResult: 'KNOWN_FAILURE' };
  const rows = Object.entries(settings).map(([name, value]) => ({
    key: ({ deliveryChargeDhaka: 'delivery_charge_dhaka', deliveryChargeOutsideDhaka: 'delivery_charge_outside_dhaka', returnDeliveryCharge: 'return_delivery_charge', websiteApiBaseUrl: 'website_api_base_url', pageId: 'page_id', deliveryCompanyId: 'delivery_company_id', utmSource: 'utm_source', utmCampaign: 'utm_campaign' } as Record<string, string>)[name], value,
  }));
  const tx = { order: { update: async ({ data }: any) => { persisted = data; return data; } }, systemLog: { create: async () => ({}) } };
  const db = {
    order: { findUnique: async () => retryOrder, updateMany: async () => ({ count: 1 }) },
    product: { findUnique: async () => currentProduct },
    setting: { createMany: async () => ({ count: 0 }), findMany: async () => rows },
    systemLog: { create: async () => ({}) },
    $transaction: async (callback: any) => callback(tx),
  };
  const client = new WebsiteOrderApiClient(1000, async () => response({ status: 200, code: ['EXT-77'] }));
  const service = new OrderService(db as never, client);
  await service.retryOrderSubmission('order-uuid');
  assert.equal(persisted.externalOrderId, 'EXT-77'); assert.equal(persisted.submissionResult, 'SUCCEEDED');
});
