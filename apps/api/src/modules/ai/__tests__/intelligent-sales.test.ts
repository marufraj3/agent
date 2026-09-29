import assert from 'node:assert/strict';
import test from 'node:test';
import { extractEntities } from '../entity-extractor.js';
import { normalizeCustomerText } from '../language-normalizer.js';
import { classifyIntent } from '../ai-router.js';
import { parseModelResponse } from '../model-response.js';

test('normalizes Banglish and Bangla digits without mutating the source value', () => {
  const source = 'APL ২৬ er daam ache?';
  assert.equal(normalizeCustomerText(source), 'apl 26 er price available');
  assert.equal(source, 'APL ২৬ er daam ache?');
});

test('extracts combined order fields, preferences, budget and correction', () => {
  const entities = extractEntities('Name: Rahim, Phone: ০১৭১২-৩৪৫৬৭৮, Address: Dhanmondi 27, Dhaka; black XL 2টা, 1500-2500, আগেরটার বদলে');
  assert.equal(entities.customerName, 'Rahim');
  assert.equal(entities.phone, '01712345678');
  assert.equal(entities.address, 'Dhanmondi 27, Dhaka');
  assert.equal(entities.color, 'black');
  assert.equal(entities.size, 'XL');
  assert.equal(entities.quantity, 2);
  assert.equal(entities.minPrice, 1500);
  assert.equal(entities.maxPrice, 2500);
  assert.equal(entities.correction, true);
});

test('extracts ordinal context and classifies recommendation intent', () => {
  assert.equal(extractEntities('second product ta navy color-e chai').ordinalReference, 2);
  assert.equal(classifyIntent('Suggest polo options under 2k'), 'product_search');
});

test('rejects structured model decisions with unsupported actions or missing entities', () => {
  assert.equal(parseModelResponse(JSON.stringify({ reply: 'ok', intent: 'general_question', confidence: 1, language: 'en', requiresHuman: false, action: 'delete_database', productIds: [] })), null);
});
