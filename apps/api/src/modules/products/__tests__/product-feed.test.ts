import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFeedEnvelope } from '../product-feed.client.js';
import { parseProductFeedItem } from '../product-feed.schemas.js';
import {
  isKnownActiveProductStatus,
  isVariationOrderable,
} from '../product-catalog.service.js';

const productFixture = {
  id: 6238,
  product_name: 'TX170 Messi Fan Edition Polo',
  product_category_id: 1,
  product_code: 'TX170 Argentina',
  slug: 'tx170-messi-fan-edition-polo',
  product_details: 'Sample',
  product_status: '1',
  product_sub_category_id: 7,
  product_image: 'https://example.com/product.webp',
  sell_price: 1250,
  discount_price: 990,
  flash_sell_price: 0,
  is_pre_order: true,
  additional_future_field: 'ignored safely',
  details: [
    {
      id: 41375,
      product_id: 6238,
      active: 1,
      product_size_id: 2,
      pro_qty: 24,
      size: { id: 2, size_name: 'M', future_field: true },
    },
    {
      id: 41376,
      product_id: 6238,
      active: 1,
      product_size_id: 3,
      pro_qty: 22,
      size: { id: 3, size_name: 'L' },
    },
    {
      id: 41377,
      product_id: 6238,
      active: 1,
      product_size_id: 4,
      pro_qty: 16,
      size: { id: 4, size_name: 'XL' },
    },
    {
      id: 41378,
      product_id: 6238,
      active: 1,
      product_size_id: 5,
      pro_qty: 18,
      size: { id: 5, size_name: 'XXL' },
    },
  ],
};

test('parses the observed product and variation fields without floating-point calculations', () => {
  const parsed = parseProductFeedItem(productFixture);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;

  assert.equal(parsed.product.websiteProductId, 6238);
  assert.equal(parsed.product.sellPrice, '1250');
  assert.equal(parsed.product.discountPrice, '990');
  assert.equal(parsed.product.isPreOrder, true);
  assert.deepEqual(
    Object.fromEntries(parsed.product.variations.map((item) => [item.sizeName, item.stockQuantity])),
    { M: 24, L: 22, XL: 16, XXL: 18 },
  );
});

test('parses changed stock so a later upsert can replace the stored quantity', () => {
  const changed = structuredClone(productFixture);
  changed.details[0]!.pro_qty = 7;

  const parsed = parseProductFeedItem(changed);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.product.variations[0]?.stockQuantity, 7);
});

test('supports simple-array and Laravel-style paginated envelopes', () => {
  const simple = parseFeedEnvelope([productFixture], 'https://example.com/products');
  assert.equal(simple.items.length, 1);
  assert.equal(simple.nextUrl, null);
  assert.equal(simple.isPaginated, false);

  const paginated = parseFeedEnvelope(
    { data: [productFixture], current_page: 1, last_page: 2, next_page_url: null },
    'https://example.com/products?page=1',
  );
  assert.equal(paginated.items.length, 1);
  assert.equal(paginated.nextUrl, 'https://example.com/products?page=2');
  assert.equal(paginated.isPaginated, true);
});

test('pre-order stock at zero remains orderable while ordinary zero stock does not', () => {
  assert.equal(
    isVariationOrderable({
      stockQuantity: 0,
      variationActive: true,
      productActive: true,
      isPreOrder: true,
    }),
    true,
  );
  assert.equal(
    isVariationOrderable({
      stockQuantity: 0,
      variationActive: true,
      productActive: true,
      isPreOrder: false,
    }),
    false,
  );
});

test('unknown product statuses fail closed', () => {
  assert.equal(isKnownActiveProductStatus('1'), true);
  assert.equal(isKnownActiveProductStatus('unexpected'), false);
});
