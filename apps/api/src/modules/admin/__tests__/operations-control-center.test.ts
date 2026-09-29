import assert from 'node:assert/strict';
import test from 'node:test';
import { bounded } from '../../../routes/health.js';
import { queueName, sanitizeMetadata, sanitizeText } from '../../../routes/system.js';

test('health dependency checks are bounded and report dependency failures without throwing', async () => {
  assert.equal(await bounded(Promise.resolve('PONG'), 20), 'up');
  assert.equal(await bounded(Promise.reject(new Error('database unavailable')), 20), 'down');
  assert.equal(await bounded(new Promise(() => undefined), 5), 'down');
});

test('failed job and activity metadata recursively removes secrets', () => {
  const safe = sanitizeMetadata({
    queue: 'messenger-outgoing',
    accessToken: 'EA-this-must-never-leave-the-server',
    nested: { Authorization: 'Bearer very-secret-value', phone: '01700000000' },
    values: ['api_key=private', 'safe'],
  }) as any;
  assert.equal(safe.accessToken, '[REDACTED]');
  assert.equal(safe.nested.Authorization, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(safe), /very-secret|EA-this|private/);
  assert.equal(safe.nested.phone, '01700000000');
  assert.equal(sanitizeText('Bearer a-secret-token failed'), '[REDACTED] failed');
});

test('queue control accepts registered queues and rejects arbitrary names', () => {
  assert.equal(queueName('product-sync'), 'product-sync');
  assert.throws(() => queueName('delete-everything'), /Unknown queue/);
});
