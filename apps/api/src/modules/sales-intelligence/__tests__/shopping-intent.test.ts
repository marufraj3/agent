import assert from 'node:assert/strict';
import test from 'node:test';
import { ShoppingIntentService } from '../shopping-intent.service.js';

const service = new ShoppingIntentService();

test('detects category, budget, quality and product search without Gemini', () => {
  const intent = service.detect('ভাই ১০০০ টাকার মধ্যে ভালো একটা polo দেখান');
  assert.equal(intent.primary, 'product_search');
  assert.equal(intent.filters.category, 'polo');
  assert.equal(intent.filters.maxPrice, 1000);
  assert.ok(intent.signals.includes('price_sensitive'));
  assert.ok(intent.signals.includes('quality_focused'));
  const around = service.detect('around 1000 taka polo');
  assert.equal(around.filters.minPrice, 900);
  assert.equal(around.filters.maxPrice, 1100);
});

test('detects size and color while retaining conversation category', () => {
  const intent = service.detect('কালো আর XL আছে?', { previousCategory: 'polo' });
  assert.equal(intent.filters.category, 'polo');
  assert.equal(intent.filters.color, 'black');
  assert.equal(intent.filters.size, 'XL');
  assert.ok(intent.signals.includes('size_focused'));
  assert.ok(intent.signals.includes('color_focused'));
});

test('detects comparison, discount, ready order, human and similar-product requests', () => {
  assert.equal(service.detect('TX170 আর APL26 এর মধ্যে কোনটা নেব?').primary, 'product_comparison');
  assert.ok(service.detect('দাম একটু কম হবে?').signals.includes('discount_seeking'));
  assert.equal(service.detect('ঠিক আছে এটা নেব').primary, 'ready_to_order');
  assert.equal(service.detect('human agent চাই').primary, 'human_requested');
  assert.equal(service.detect('এইটার মতো আর একটা দেখান', { previousCategory: 'polo' }).primary, 'product_search');
  const continued = service.detect('আর একটু premium কিছু?', { previousCategory: 'polo', previousColor: 'black' });
  assert.equal(continued.primary, 'product_search');
  assert.equal(continued.filters.category, 'polo');
  assert.equal(continued.filters.color, 'black');
});

test('uses repeat and abandoned signals only when supported by stored context', () => {
  const intent = service.detect('আরও কিছু দেখান', { hasPreviousOrders: true, hasAbandonedOrder: true });
  assert.ok(intent.signals.includes('repeat_customer'));
  assert.ok(intent.signals.includes('abandoned_order'));
});
