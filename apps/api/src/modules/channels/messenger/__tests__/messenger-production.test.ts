import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptMessengerToken, decryptMessengerToken, maskMessengerToken } from '../messenger.credentials.js';
import { MessengerOutgoingProcessor, MessengerSendError } from '../messenger-outgoing.processor.js';

function fixture(sendResult: any, options: { status?: string; conversationStatus?: string; newer?: boolean } = {}) {
  const outgoing: any = { id: 'out-1', status: options.status ?? 'QUEUED', pageId: 'page-1', recipientId: 'psid-1', conversationId: 'conv-1', messageId: 'msg-1', sourceEventLogId: 'event-1', correlationId: 'trace-1', attemptCount: 0, message: { id: 'msg-1', role: 'ASSISTANT', content: 'hello', metadata: {} }, conversation: { id: 'conv-1', status: options.conversationStatus ?? 'ACTIVE' } };
  const alerts: any[] = [];
  const db: any = {
    messengerOutgoingMessage: { findUnique: async () => outgoing, update: async ({ data }: any) => { Object.assign(outgoing, data, { attemptCount: data.attemptCount?.increment ? outgoing.attemptCount + data.attemptCount.increment : outgoing.attemptCount }); return outgoing; } },
    setting: { findUnique: async () => null }, messengerPage: { findUnique: async () => ({ pageId: 'page-1', aiEnabled: true }), upsert: async () => ({}) },
    messengerEventLog: { findUnique: async () => ({ id: 'event-1', externalMessageId: 'in-1', receivedAt: new Date('2026-01-01'), responseQueuedAt: new Date('2026-01-01T00:00:02Z') }), update: async () => ({}) },
    message: { findUnique: async () => ({ id: 'source-message', createdAt: new Date('2026-01-01T00:00:01Z') }), findFirst: async () => options.newer ? ({ id: 'new' }) : null, update: async () => ({}) },
    messengerAlert: { create: async ({ data }: any) => { alerts.push(data); return data; } },
    $transaction: async (queries: any[]) => Promise.all(queries),
  };
  const provider: any = { sendText: async () => sendResult };
  return { processor: new MessengerOutgoingProcessor(db, provider), outgoing, alerts };
}

test('encrypts stored Page tokens and exposes only a masked hint', () => {
  const secret = 'a-long-credential-encryption-key-123456'; const token = 'EAAB-secret-page-token-9X'; const encrypted = encryptMessengerToken(token, secret);
  assert.notEqual(encrypted.includes(token), true); assert.equal(decryptMessengerToken(encrypted, secret), token); assert.match(maskMessengerToken(token)!, /^EAAB\*+9X$/);
});
test('outgoing processor sends one idempotent response and records provider ID', async () => {
  const x = fixture({ success: true, externalMessageId: 'mid-out', retryable: false }); const result = await x.processor.process({ outgoingId: 'out-1', correlationId: 'trace-1' });
  assert.equal(result.sent, true); assert.equal(x.outgoing.status, 'SENT'); assert.equal(x.outgoing.providerMessageId, 'mid-out');
});
test('outgoing processor cancels stale AI replies when a newer customer message exists', async () => {
  const x = fixture({ success: true, externalMessageId: 'never', retryable: false }, { newer: true }); await x.processor.process({ outgoingId: 'out-1', correlationId: 'trace-1' }); assert.equal(x.outgoing.status, 'CANCELLED');
});
test('permanent token errors do not retry and create an admin alert', async () => {
  const x = fixture({ success: false, retryable: false, errorType: 'AUTH_ERROR', errorCode: '190', errorMessage: 'expired' }); await x.processor.process({ outgoingId: 'out-1', correlationId: 'trace-1' });
  assert.equal(x.outgoing.status, 'PERMANENT_FAILURE'); assert.equal(x.alerts[0]?.type, 'TOKEN_ERROR');
});
test('duplicate outgoing jobs never send an already-sent response again', async () => {
  const x = fixture({ success: true, externalMessageId: 'duplicate', retryable: false }, { status: 'SENT' }); const result = await x.processor.process({ outgoingId: 'out-1', correlationId: 'trace-1' }); assert.equal(result.duplicate, true); assert.equal(x.outgoing.providerMessageId, undefined);
});
test('human takeover cancels pending AI responses before provider delivery', async () => {
  const x = fixture({ success: true, externalMessageId: 'never', retryable: false }, { conversationStatus: 'HUMAN' }); await x.processor.process({ outgoingId: 'out-1', correlationId: 'trace-1' }); assert.equal(x.outgoing.status, 'CANCELLED');
});
test('rate limits retry through BullMQ while uncertain timeouts stop to prevent duplicate sends', async () => {
  const rate = fixture({ success: false, retryable: true, errorType: 'RATE_LIMIT', errorCode: '4', errorMessage: 'slow down' }); await assert.rejects(() => rate.processor.process({ outgoingId: 'out-1', correlationId: 'trace-1' }), MessengerSendError);
  const uncertain = fixture({ success: false, retryable: true, uncertain: true, errorType: 'NETWORK_ERROR', errorCode: 'META_TIMEOUT', errorMessage: 'unknown result' }); await uncertain.processor.process({ outgoingId: 'out-1', correlationId: 'trace-1' }); assert.equal(uncertain.outgoing.status, 'FAILED'); assert.equal(uncertain.alerts[0]?.type, 'SEND_STATUS_UNCERTAIN');
});
