import assert from 'node:assert/strict';
import test from 'node:test';
import { AIServiceError, AppError, RateLimitError, ValidationError } from '../../../errors/app-error.js';
import { CircuitBreaker, CircuitOpenError } from '../../../infrastructure/circuit-breaker.js';
import { enforceRateLimit } from '../../../infrastructure/rate-limit.js';

test('central errors expose only intended client errors', () => {
  assert.equal(new ValidationError('bad').statusCode, 400);
  assert.equal(new AppError('secret').expose, false);
  assert.equal(new RateLimitError().code, 'RATE_LIMITED');
  assert.equal(new AIServiceError().retryable, true);
});

test('circuit opens after threshold and recovers through half-open probe', async () => {
  const breaker = new CircuitBreaker('test-service', 2, 5);
  await assert.rejects(() => breaker.execute(async () => { throw new Error('down'); }));
  await assert.rejects(() => breaker.execute(async () => { throw new Error('down'); }));
  await assert.rejects(() => breaker.execute(async () => 'blocked'), CircuitOpenError);
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.equal(await breaker.execute(async () => 'up'), 'up');
  assert.equal(breaker.snapshot().state, 'closed');
});

test('redis rate limiter rejects beyond a fixed-window budget', async () => {
  const values = new Map<string, number>();
  const redis = {
    incr: async (key: string) => { const value = (values.get(key) ?? 0) + 1; values.set(key, value); return value; },
    expire: async () => 1,
  };
  await enforceRateLimit(redis as never, 'test', 'customer', 2, 60);
  await enforceRateLimit(redis as never, 'test', 'customer', 2, 60);
  await assert.rejects(() => enforceRateLimit(redis as never, 'test', 'customer', 2, 60), RateLimitError);
});
