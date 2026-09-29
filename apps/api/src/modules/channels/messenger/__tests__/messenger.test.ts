import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { MessengerEventParser } from '../messenger.parser.js';
import { verifyMessengerSignature } from '../messenger.signature.js';
import { MessengerSender } from '../messenger.sender.js';
import { MessengerService, MessengerProcessingError } from '../messenger.service.js';
import { MessengerMessageDeliveryProvider } from '../messenger.delivery.js';

const secret = 'a-facebook-app-secret-for-tests';
const config = { appSecret: secret, verifyToken: 'verify-token-long-enough', pageId: 'page-1', pageAccessToken: 'page-access-token-for-tests', graphApiVersion: 'v25.0', timeoutMs: 100 };
function payload(message: Record<string, unknown>, sender = 'user-1') {
  return { object: 'page', entry: [{ id: 'page-1', messaging: [{ sender: { id: sender }, recipient: { id: 'page-1' }, timestamp: 123, message }] }] };
}
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('validates a correct Meta HMAC SHA-256 signature against raw bytes', () => {
  const raw = Buffer.from('{"object":"page"}'); const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(verifyMessengerSignature(raw, signature, secret), true);
});
test('rejects invalid, malformed, and absent webhook signatures', () => {
  assert.equal(verifyMessengerSignature(Buffer.from('x'), `sha256=${'0'.repeat(64)}`, secret), false);
  assert.equal(verifyMessengerSignature(Buffer.from('x'), 'sha1=bad', secret), false);
  assert.equal(verifyMessengerSignature(Buffer.from('x'), undefined, secret), false);
});
test('parses a Messenger text message into channel-neutral data', () => {
  const event = new MessengerEventParser().parse(payload({ mid: 'm1', text: 'Messi polo কত?' }), 'page-1')[0]!;
  assert.equal(event.messageType, 'text'); assert.equal(event.senderId, 'user-1'); assert.equal(event.text, 'Messi polo কত?');
});
test('parses an image attachment for the existing image pipeline', () => {
  const event = new MessengerEventParser().parse(payload({ mid: 'm2', attachments: [{ type: 'image', payload: { url: 'https://cdn.example/image.jpg' } }] }), 'page-1')[0]!;
  assert.equal(event.messageType, 'image'); assert.equal(event.attachmentUrl, 'https://cdn.example/image.jpg');
});
test('parses a voice attachment for the existing audio pipeline', () => {
  const event = new MessengerEventParser().parse(payload({ mid: 'm3', attachments: [{ type: 'audio', payload: { url: 'https://cdn.example/voice.mp4', mime_type: 'audio/mp4' } }] }), 'page-1')[0]!;
  assert.equal(event.messageType, 'audio'); assert.equal(event.mimeType, 'audio/mp4');
});
test('normalizes unsupported attachments without crashing', () => {
  const event = new MessengerEventParser().parse(payload({ mid: 'm4', attachments: [{ type: 'file', payload: { url: 'https://cdn.example/a.pdf' } }] }), 'page-1')[0]!;
  assert.equal(event.messageType, 'unsupported'); assert.match(event.text, /Unsupported/);
});
test('drops echo events to prevent outbound message loops', () => {
  assert.equal(new MessengerEventParser().parse(payload({ mid: 'm5', text: 'echo', is_echo: true }), 'page-1').length, 0);
});
test('drops events sent by the configured Page itself', () => {
  assert.equal(new MessengerEventParser().parse(payload({ mid: 'm6', text: 'self' }, 'page-1'), 'page-1').length, 0);
});
test('drops events addressed to another Page', () => {
  const value = payload({ mid: 'm7', text: 'wrong' }); (value.entry[0]!.messaging[0]!.recipient as any).id = 'other';
  assert.equal(new MessengerEventParser().parse(value, 'page-1').length, 0);
});
test('parses multiple rapid messages from one webhook batch', () => {
  const value = payload({ mid: 'm8', text: 'one' }); value.entry[0]!.messaging.push({ sender: { id: 'user-1' }, recipient: { id: 'page-1' }, timestamp: 124, message: { mid: 'm9', text: 'two' } });
  assert.deepEqual(new MessengerEventParser().parse(value, 'page-1').map((item) => item.messageId), ['m8', 'm9']);
});
test('rejects non-Page and wrong configured Page payloads', () => {
  const parser = new MessengerEventParser(); assert.equal(parser.parse({ object: 'user', entry: [] }).length, 0); assert.equal(parser.parse(payload({ mid: 'm10', text: 'x' }), 'other-page').length, 0);
});

test('Messenger sender uses Graph v25.0, bearer token, and RESPONSE messaging type', async () => {
  let url = ''; let init: RequestInit | undefined;
  const sender = new MessengerSender(config, async (input, options) => { url = String(input); init = options; return response({ recipient_id: 'u', message_id: 'out-1' }); });
  const result = await sender.sendText('user-1', 'hello');
  assert.equal(result.externalMessageId, 'out-1'); assert.match(url, /v25\.0\/page-1\/messages$/); assert.equal(url.includes(config.pageAccessToken!), false);
  assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${config.pageAccessToken}`); assert.equal(JSON.parse(String(init?.body)).messaging_type, 'RESPONSE');
});
test('Messenger sender handles invalid recipients as a known failure', async () => {
  const sender = new MessengerSender(config, async () => response({ error: { code: 100, message: 'Invalid recipient' } }, 400));
  const result = await sender.sendText('bad', 'hello'); assert.equal(result.success, false); assert.equal(result.retryable, false); assert.equal(result.errorCode, '100');
});
test('Messenger sender handles expired tokens without exposing tokens', async () => {
  const sender = new MessengerSender(config, async () => response({ error: { code: 190, message: 'Token expired' } }, 401));
  const result = await sender.sendText('u', 'hello'); assert.equal(result.errorCode, '190'); assert.equal(JSON.stringify(result).includes(config.pageAccessToken!), false);
});
test('Messenger sender classifies permission errors as non-retryable', async () => {
  const sender = new MessengerSender(config, async () => response({ error: { code: 200, message: 'Permission denied' } }, 403));
  assert.equal((await sender.sendText('u', 'hello')).retryable, false);
});
test('Messenger sender classifies rate limits as retryable', async () => {
  const sender = new MessengerSender(config, async () => response({ error: { code: 4, message: 'Rate limit', is_transient: true } }, 429));
  assert.equal((await sender.sendText('u', 'hello')).retryable, true);
});
test('Messenger sender classifies HTTP 5xx as retryable', async () => {
  const sender = new MessengerSender(config, async () => response({ error: { code: 2, message: 'Temporary' } }, 503));
  assert.equal((await sender.sendText('u', 'hello')).retryable, true);
});
test('Messenger sender handles timeout without falsely reporting sent', async () => {
  const sender = new MessengerSender({ ...config, timeoutMs: 5 }, (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')))));
  const result = await sender.sendText('u', 'hello'); assert.equal(result.success, false); assert.equal(result.errorCode, 'META_TIMEOUT');
});
test('Messenger sender rejects malformed success responses', async () => {
  const sender = new MessengerSender(config, async () => response({ recipient_id: 'u' }));
  const result = await sender.sendText('u', 'hello'); assert.equal(result.success, false); assert.equal(result.errorCode, 'META_MALFORMED_RESPONSE');
});
test('Messenger sender fails closed when credentials are absent', async () => {
  const sender = new MessengerSender({ graphApiVersion: 'v25.0', timeoutMs: 100 });
  assert.equal((await sender.sendText('u', 'hello')).errorCode, 'MESSENGER_NOT_CONFIGURED');
});
test('Messenger delivery provider maps successful external IDs', async () => {
  const provider = new MessengerMessageDeliveryProvider(new MessengerSender(config, async () => response({ message_id: 'external-2' })));
  const result = await provider.sendMessage({ conversationId: 'c', channel: 'MESSENGER', recipientId: 'u', content: 'hi' });
  assert.equal(result.status, 'sent'); assert.equal(result.providerMessageId, 'external-2');
});

function serviceMemory(options: { chatResult?: any; sendResult?: any; status?: string; outboundId?: string } = {}) {
  const log: any = { id: 'log-1', status: options.status ?? 'QUEUED', localOutboundMessageId: options.outboundId ?? null };
  const messages = new Map<string, any>();
  if (options.outboundId) messages.set(options.outboundId, { id: options.outboundId, content: 'retry me', metadata: {} });
  const updates: any[] = []; const chatInputs: any[] = []; const audioInputs: any[] = []; const imageInputs: any[] = []; let sends = 0;
  const db: any = {
    messengerEventLog: { findUnique: async () => log, update: async ({ data }: any) => { Object.assign(log, data); return log; } },
    message: {
      findUnique: async ({ where }: any) => messages.get(where.id) ?? null,
      update: async ({ where, data }: any) => { const value = { ...(messages.get(where.id) ?? { id: where.id, content: 'AI reply', metadata: {} }), ...data }; messages.set(where.id, value); updates.push(data); return value; },
    },
  };
  const chat: any = { send: async (input: any) => { chatInputs.push(input); const result = options.chatResult ?? { reply: 'AI reply', assistantMessageId: 'assistant-1' }; messages.set('assistant-1', { id: 'assistant-1', content: result.reply, metadata: { intent: 'x' } }); return result; } };
  const sender: any = { sendText: async () => { sends += 1; return options.sendResult ?? { success: true, externalMessageId: 'meta-out-1', retryable: false }; } };
  const event = { externalEventId: 'meta-in-1', messageId: 'meta-in-1', senderId: 'psid-1', pageId: 'page-1', timestamp: 123, messageType: 'text' as const, text: 'hello' };
  const audioIngestion: any = { ingest: async (...input: any[]) => { audioInputs.push(input); return { messageId: 'audio-message-1', conversationId: 'conversation-1', customerId: 'customer-1' }; } };
  const imageIngestion: any = { ingest: async (...input: any[]) => { imageInputs.push(input); return { messageId: 'image-message-1', conversationId: 'conversation-1', customerId: 'customer-1' }; } };
  return { service: new MessengerService(db, chat, sender, undefined, audioIngestion, imageIngestion), log, messages, updates, chatInputs, audioInputs, imageInputs, event, sends: () => sends };
}

test('processor maps new and existing Messenger customers through the same ChatService input', async () => {
  const memory = serviceMemory(); await memory.service.process({ eventLogId: 'log-1', event: memory.event });
  assert.deepEqual(memory.chatInputs[0].customer, { platform: 'messenger', platformUserId: 'psid-1' }); assert.equal(memory.chatInputs[0].channel, 'messenger');
});
test('processor stores the inbound external message ID for deduplication', async () => {
  const memory = serviceMemory(); await memory.service.process({ eventLogId: 'log-1', event: memory.event });
  assert.equal(memory.chatInputs[0].externalMessageId, 'meta-in-1'); assert.equal(memory.chatInputs[0].sourceMetadata.direction, 'inbound');
});
test('processor persists and queues images without invoking ChatService or vision inline', async () => {
  const memory = serviceMemory(); const event: any = { ...memory.event, messageType: 'image', attachmentUrl: 'https://cdn.example/i.jpg', text: 'L size ache?' };
  const result = await memory.service.process({ eventLogId: 'log-1', event });
  assert.equal(memory.imageInputs.length, 1); assert.equal(memory.chatInputs.length, 0); assert.equal(memory.sends(), 0);
  assert.equal(memory.log.status, 'QUEUED'); assert.equal('queued' in result && result.queued, true);
});
test('processor persists and queues voice without invoking ChatService or STT inline', async () => {
  const memory = serviceMemory(); const event: any = { ...memory.event, messageType: 'audio', attachmentUrl: 'https://cdn.example/a.mp4', text: '' };
  const result = await memory.service.process({ eventLogId: 'log-1', event });
  assert.equal(memory.audioInputs.length, 1);
  assert.equal(memory.chatInputs.length, 0);
  assert.equal(memory.sends(), 0);
  assert.equal(memory.log.status, 'QUEUED');
  assert.equal('queued' in result && result.queued, true);
});
test('human-owned conversation result does not produce an automatic outbound reply', async () => {
  const memory = serviceMemory({ chatResult: { reply: null, conversationStatus: 'human' } });
  const result = await memory.service.process({ eventLogId: 'log-1', event: memory.event }); assert.equal(memory.sends(), 0); assert.equal('humanLocked' in result && result.humanLocked, true);
});
test('AI handover reply is delivered once and event completes', async () => {
  const memory = serviceMemory({ chatResult: { reply: 'একজন টিম মেম্বার সাহায্য করবেন।', assistantMessageId: 'assistant-1', requiresHuman: true } });
  await memory.service.process({ eventLogId: 'log-1', event: memory.event }); assert.equal(memory.sends(), 1); assert.equal(memory.log.status, 'PROCESSED');
});
test('outbound AI reply records Meta external message ID and sent status', async () => {
  const memory = serviceMemory(); await memory.service.process({ eventLogId: 'log-1', event: memory.event });
  assert.equal(memory.messages.get('assistant-1').externalMessageId, 'meta-out-1'); assert.equal(memory.messages.get('assistant-1').metadata.delivery.status, 'sent');
});
test('temporary outbound failure is marked for queue retry', async () => {
  const memory = serviceMemory({ sendResult: { success: false, retryable: true, errorCode: 'META_TIMEOUT', errorMessage: 'timeout' } });
  await assert.rejects(() => memory.service.process({ eventLogId: 'log-1', event: memory.event }), (error: unknown) => error instanceof MessengerProcessingError && error.retryable);
  assert.equal(memory.log.status, 'DELIVERY_FAILED');
});
test('delivery retry does not run ChatService or duplicate order logic', async () => {
  const memory = serviceMemory({ status: 'DELIVERY_FAILED', outboundId: 'assistant-1' });
  await memory.service.process({ eventLogId: 'log-1', event: memory.event }); assert.equal(memory.chatInputs.length, 0); assert.equal(memory.sends(), 1);
});
test('processed duplicate event does not invoke AI or delivery again', async () => {
  const memory = serviceMemory({ status: 'PROCESSED' }); const result = await memory.service.process({ eventLogId: 'log-1', event: memory.event });
  assert.equal('duplicate' in result && result.duplicate, true); assert.equal(memory.chatInputs.length, 0); assert.equal(memory.sends(), 0);
});

async function webhookApp() {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.ADMIN_PASSWORD = 'a-secure-admin-password';
  process.env.FACEBOOK_VERIFY_TOKEN = config.verifyToken;
  process.env.FACEBOOK_APP_SECRET = config.appSecret;
  process.env.FACEBOOK_PAGE_ID = config.pageId;
  process.env.FACEBOOK_PAGE_ACCESS_TOKEN = config.pageAccessToken;
  const [{ default: Fastify }, { messengerRoutes }] = await Promise.all([import('fastify'), import('../routes/messenger.routes.js')]);
  const logs: any[] = []; const queued: any[] = []; const audioQueued: any[] = []; const imageQueued: any[] = []; const messages: any[] = []; const audioRecords: any[] = []; const imageRecords: any[] = [];
  const customer = { id: 'customer-1', platform: 'messenger', platformUserId: 'user-1' };
  const conversation = { id: 'conversation-1', customerId: customer.id, channel: 'MESSENGER', status: 'ACTIVE' };
  const transaction: any = {
    message: { create: async ({ data }: any) => { const value = { id: `message-${messages.length + 1}`, ...data }; messages.push(value); return value; } },
    conversation: { update: async () => conversation },
  };
  const db: any = {
    messengerEventLog: {
      findUnique: async ({ where }: any) => logs.find((item) => item.externalEventId === where.externalEventId) ?? null,
      create: async ({ data }: any) => { const item = { id: `log-${logs.length + 1}`, ...data }; logs.push(item); return item; },
      update: async ({ where, data }: any) => { const item = logs.find((value) => value.id === where.id); return Object.assign(item, data); },
      findFirst: async () => null,
    },
    message: { findUnique: async ({ where }: any) => messages.find((item) => item.externalMessageId === where.externalMessageId) ?? null },
    customer: { upsert: async () => customer },
    conversation: { findFirst: async () => conversation, create: async () => conversation },
    audioTranscription: { create: async ({ data }: any) => { const value = { id: `audio-${audioRecords.length + 1}`, ...data }; audioRecords.push(value); return value; }, findUnique: async () => null },
    imageProcessing: { create: async ({ data }: any) => { const value = { id: `image-${imageRecords.length + 1}`, ...data }; imageRecords.push(value); return value; }, findUnique: async () => null },
    $transaction: async (value: any) => typeof value === 'function' ? value(transaction) : Promise.all(value),
  };
  const app = Fastify(); app.decorate('prisma', db);
  app.decorate('redis', { incr: async () => 1, expire: async () => 1 } as never);
  app.decorate('messengerEventQueue', { add: async (_name: string, data: any) => { queued.push(data); return { id: 'job-1' }; } } as never);
  app.decorate('audioTranscriptionQueue', { add: async (_name: string, data: any) => { audioQueued.push(data); return { id: 'audio-job-1' }; } } as never);
  app.decorate('imageAnalysisQueue', { add: async (_name: string, data: any) => { imageQueued.push(data); return { id: 'image-job-1' }; } } as never);
  await app.register(messengerRoutes); return { app, logs, queued, audioQueued, imageQueued, messages, audioRecords, imageRecords };
}

test('Facebook webhook verification returns the exact challenge', async () => {
  const { app } = await webhookApp();
  const result = await app.inject({ method: 'GET', url: `/api/webhooks/facebook?hub.mode=subscribe&hub.verify_token=${config.verifyToken}&hub.challenge=challenge-123` });
  assert.equal(result.statusCode, 200); assert.equal(result.body, 'challenge-123'); await app.close();
});
test('Facebook webhook verification rejects an invalid token', async () => {
  const { app } = await webhookApp();
  const result = await app.inject({ method: 'GET', url: '/api/webhooks/facebook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x' });
  assert.equal(result.statusCode, 403); await app.close();
});
test('signed Facebook webhook is persisted, queued, and acknowledged without AI processing', async () => {
  const { app, logs, queued } = await webhookApp(); const raw = JSON.stringify(payload({ mid: 'webhook-mid-1', text: 'hello' }));
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const result = await app.inject({ method: 'POST', url: '/api/webhooks/facebook', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, payload: raw });
  assert.equal(result.statusCode, 200); assert.equal(result.body, 'EVENT_RECEIVED'); assert.equal(logs.length, 1); assert.equal(queued.length, 1); await app.close();
});
test('signed voice webhook persists audio lifecycle and queues STT before acknowledging', async () => {
  const { app, queued, audioQueued, messages, audioRecords } = await webhookApp();
  const raw = JSON.stringify(payload({ mid: 'webhook-audio-1', attachments: [{ type: 'audio', payload: { url: 'https://cdn.example/voice.ogg', mime_type: 'audio/ogg' } }] }));
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const result = await app.inject({ method: 'POST', url: '/api/webhooks/facebook', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, payload: raw });
  assert.equal(result.statusCode, 200);
  assert.equal(messages[0].messageType, 'AUDIO');
  assert.equal(audioRecords[0].status, 'PENDING');
  assert.equal(audioQueued.length, 1);
  assert.equal(queued.length, 0);
  await app.close();
});
test('signed image webhook persists caption metadata and queues vision before acknowledging', async () => {
  const { app, queued, imageQueued, messages, imageRecords } = await webhookApp();
  const raw = JSON.stringify(payload({ mid: 'webhook-image-1', text: 'L size ache?', attachments: [{ type: 'image', payload: { url: 'https://cdn.example/product.jpg', mime_type: 'image/jpeg' } }] }));
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const result = await app.inject({ method: 'POST', url: '/api/webhooks/facebook', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, payload: raw });
  assert.equal(result.statusCode, 200); assert.equal(messages[0].messageType, 'IMAGE'); assert.equal(messages[0].content, 'L size ache?');
  assert.equal(imageRecords[0].status, 'PENDING'); assert.equal(imageQueued.length, 1); assert.equal(queued.length, 0); await app.close();
});
test('Facebook webhook rejects invalid signatures before persistence', async () => {
  const { app, logs } = await webhookApp(); const raw = JSON.stringify(payload({ mid: 'webhook-mid-2', text: 'hello' }));
  const result = await app.inject({ method: 'POST', url: '/api/webhooks/facebook', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, payload: raw });
  assert.equal(result.statusCode, 401); assert.equal(logs.length, 0); await app.close();
});
test('repeated webhook message ID is acknowledged without a second queue job', async () => {
  const { app, queued } = await webhookApp(); const raw = JSON.stringify(payload({ mid: 'webhook-mid-3', text: 'hello' }));
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`; const request = { method: 'POST' as const, url: '/api/webhooks/facebook', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, payload: raw };
  assert.equal((await app.inject(request)).statusCode, 200); assert.equal((await app.inject(request)).statusCode, 200); assert.equal(queued.length, 1); await app.close();
});

test('Messenger order intent is passed unchanged to the existing Order Engine orchestration', async () => {
  const memory = serviceMemory(); const event = { ...memory.event, text: 'TX170 M size order করতে চাই' };
  await memory.service.process({ eventLogId: 'log-1', event }); assert.equal(memory.chatInputs[0].message, event.text);
});
test('Messenger final confirmation is passed unchanged for persisted order confirmation checks', async () => {
  const memory = serviceMemory(); const event = { ...memory.event, text: 'জি' };
  await memory.service.process({ eventLogId: 'log-1', event }); assert.equal(memory.chatInputs[0].message, 'জি');
});
