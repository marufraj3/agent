import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@alzeena/database';
import Fastify from 'fastify';
import { HumanHandoverService } from '../human-handover.service.js';
import { AdminInboxService } from '../../inbox/admin-inbox.service.js';
import { MessageDeliveryService } from '../../inbox/message-delivery.service.js';
import { inboxQuerySchema } from '../../inbox/inbox.schemas.js';

process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_PASSWORD = 'a-secure-admin-password';

function handoverMemory(status = 'ACTIVE') {
  const conversation: any = { id: '11111111-1111-4111-8111-111111111111', customerId: 'c1', status, assignedTo: null, consecutiveAiFailures: 0 };
  const handovers: any[] = [];
  const notifications: any[] = [];
  const logs: any[] = [];
  const db: any = {
    conversation: {
      findUnique: async () => conversation,
      update: async ({ data }: any) => Object.assign(conversation, data),
    },
    conversationHandover: {
      findFirst: async ({ where }: any) => handovers.find((item) => item.conversationId === where.conversationId && (where.status?.in ?? []).includes(item.status)) ?? null,
      findUnique: async ({ where }: any) => handovers.find((item) => item.id === where.id) ?? null,
      create: async ({ data }: any) => { const item = { id: `h${handovers.length + 1}`, status: 'PENDING', createdAt: new Date(), ...data }; handovers.push(item); return item; },
      update: async ({ where, data }: any) => { const item = handovers.find((value) => value.id === where.id); return Object.assign(item, data); },
      findMany: async ({ where, skip, take }: any) => handovers.filter((item) => item.status === where.status && (!where.assignedTo || item.assignedTo === where.assignedTo)).slice(skip, skip + take),
    },
    adminNotification: { create: async ({ data }: any) => { notifications.push(data); return data; } },
    systemLog: { create: async ({ data }: any) => { logs.push(data); return data; } },
  };
  db.$transaction = async (callback: any) => callback(db);
  return { prisma: db as PrismaClient, conversation, handovers, notifications, logs };
}

async function requestedMemory() {
  const memory = handoverMemory();
  const service = new HumanHandoverService(memory.prisma);
  const handover = await service.requestHandover({ conversationId: memory.conversation.id, reason: 'customer_requested_human', note: 'Please help', createdBy: 'ai' });
  return { ...memory, service, handover };
}

test('requests a structured human handover', async () => {
  const memory = await requestedMemory();
  assert.equal(memory.handover.reason, 'CUSTOMER_REQUESTED_HUMAN'); assert.equal(memory.handover.note, 'Please help');
});
test('requesting handover changes conversation to human', async () => {
  const memory = await requestedMemory(); assert.equal(memory.conversation.status, 'HUMAN');
});
test('handover request is idempotent while one is open', async () => {
  const memory = await requestedMemory();
  const again = await memory.service.requestHandover({ conversationId: memory.conversation.id, reason: 'other', createdBy: 'admin' });
  assert.equal(again.id, memory.handover.id); assert.equal(memory.handovers.length, 1);
});
test('handover creates an internal admin notification', async () => {
  const memory = await requestedMemory(); assert.equal(memory.notifications.length, 1); assert.equal(memory.notifications[0].type, 'HUMAN_HANDOVER_REQUESTED');
});
test('takes and assigns a conversation to the authenticated admin identity', async () => {
  const memory = await requestedMemory(); await memory.service.assignConversation(memory.conversation.id, 'admin');
  assert.equal(memory.handover.status, 'ASSIGNED'); assert.equal(memory.conversation.assignedTo, 'admin');
});
test('releases an assigned conversation', async () => {
  const memory = await requestedMemory(); await memory.service.assignConversation(memory.conversation.id, 'admin'); await memory.service.unassignConversation(memory.conversation.id);
  assert.equal(memory.handover.status, 'PENDING'); assert.equal(memory.conversation.assignedTo, null);
});
test('resolves handover and returns conversation to AI', async () => {
  const memory = await requestedMemory(); await memory.service.resolveHandover(memory.handover.id, 'admin', 'Solved', true);
  assert.equal(memory.handover.status, 'RESOLVED'); assert.equal(memory.conversation.status, 'ACTIVE'); assert.equal(memory.handover.resolvedBy, 'admin');
});
test('cancels handover without leaving the AI lock active', async () => {
  const memory = await requestedMemory(); await memory.service.cancelHandover(memory.handover.id);
  assert.equal(memory.handover.status, 'CANCELLED'); assert.equal(memory.conversation.status, 'ACTIVE');
});
test('lists pending handovers with pagination', async () => {
  const memory = await requestedMemory(); const rows = await memory.service.getPendingHandovers(1, 25); assert.equal(rows.length, 1);
});
test('lists only handovers assigned to the current admin', async () => {
  const memory = await requestedMemory(); await memory.service.assignConversation(memory.conversation.id, 'admin');
  assert.equal((await memory.service.getAssignedHandovers('admin')).length, 1); assert.equal((await memory.service.getAssignedHandovers('other')).length, 0);
});
test('handover lifecycle logs contain IDs but not customer message text', async () => {
  const memory = await requestedMemory(); await memory.service.assignConversation(memory.conversation.id, 'admin');
  assert.equal(memory.logs.length >= 2, true); assert.equal(JSON.stringify(memory.logs).includes('Please help'), false);
});

test('inbox query applies server pagination instead of browser-side loading', async () => {
  let request: any;
  const db: any = { conversation: { findMany: async (value: any) => { request = value; return []; }, count: async () => 0 } };
  const result = await new AdminInboxService(db).list({ page: 3, limit: 25, filter: 'all' });
  assert.equal(request.skip, 50); assert.equal(request.take, 25); assert.equal(result.page, 3);
});
test('inbox phone search is translated to a database relation filter', async () => {
  let where: any;
  const db: any = { conversation: { findMany: async (value: any) => { where = value.where; return []; }, count: async () => 0 } };
  await new AdminInboxService(db).list({ page: 1, limit: 25, filter: 'all', search: '01712345678' });
  assert.equal(JSON.stringify(where).includes('phone'), true);
});
test('inbox order ID search is translated to a database order filter', async () => {
  let where: any; const orderId = '22222222-2222-4222-8222-222222222222';
  const db: any = { conversation: { findMany: async (value: any) => { where = value.where; return []; }, count: async () => 0 } };
  await new AdminInboxService(db).list({ page: 1, limit: 25, filter: 'all', search: orderId });
  assert.equal(JSON.stringify(where).includes(orderId), true); assert.equal(JSON.stringify(where).includes('orders'), true);
});
test('inbox product code search is performed in order items by the database', async () => {
  let where: any;
  const db: any = { conversation: { findMany: async (value: any) => { where = value.where; return []; }, count: async () => 0 } };
  await new AdminInboxService(db).list({ page: 1, limit: 25, filter: 'all', search: 'TX170' });
  assert.equal(JSON.stringify(where).includes('productCode'), true);
});
test('inbox schema limits page sizes', () => {
  assert.equal(inboxQuerySchema.safeParse({ limit: 101 }).success, false); assert.equal(inboxQuerySchema.parse({}).page, 1);
});

test('admin opens conversation and clears unread state', async () => {
  let updated: any;
  const detail: any = { id: 'v', unreadForAdmin: true, messages: [], customer: {}, handovers: [], orders: [], notifications: [] };
  const tx: any = { conversation: { update: async ({ data }: any) => { updated = data; } }, adminNotification: { updateMany: async () => ({ count: 1 }) } };
  const db: any = { conversation: { findUnique: async () => detail }, product: { findMany: async () => [] }, $transaction: async (callback: any) => callback(tx) };
  const result = await new AdminInboxService(db).getConversation('v'); assert.equal(result.unreadForAdmin, false); assert.equal(updated.unreadForAdmin, false);
});
test('conversation detail includes existing orders, image context, and voice transcription', async () => {
  const detail: any = {
    id: 'v', unreadForAdmin: false, customer: {}, handovers: [], notifications: [],
    orders: [{ id: 'o', status: 'SUBMITTED', items: [{ productCode: 'TX170' }] }],
    messages: [
      { messageType: 'IMAGE', metadata: { productIds: [6238], image: { url: 'https://example.test/a.jpg' } } },
      { messageType: 'AUDIO', metadata: { transcription: { text: 'TX170 লাগবে' } } },
    ],
  };
  const db: any = { conversation: { findUnique: async () => detail }, product: { findMany: async () => [{ websiteProductId: 6238, productName: 'Polo', productCode: 'TX170', sellPrice: { toString: () => '990', greaterThan: () => true }, discountPrice: null, flashSellPrice: null, isPreOrder: false, presentInFeed: true, productStatus: '1', variations: [] }] } };
  const result = await new AdminInboxService(db).getConversation('v');
  assert.equal(result.orders[0].id, 'o'); assert.equal(result.messages[0].metadata.image.url.includes('jpg'), true); assert.equal(result.messages[1].metadata.transcription.text, 'TX170 লাগবে'); assert.equal(result.discussedProducts[0].code, 'TX170');
});
test('admin human reply is delivered locally and stored with HUMAN role', async () => {
  let saved: any; let logged: any;
  const tx: any = { message: { create: async ({ data }: any) => { saved = { id: 'm', ...data }; return saved; }, update: async ({ data }: any) => Object.assign(saved, data) }, conversation: { update: async () => ({}) }, systemLog: { create: async ({ data }: any) => { logged = data; } } };
  const db: any = { conversation: { findUnique: async () => ({ id: 'v', status: 'HUMAN', channel: 'TEST', customerId: 'c', customer: { platformUserId: 'u' } }) }, $transaction: async (callback: any) => callback(tx) };
  const delivery = new MessageDeliveryService({ name: 'test', sendMessage: async () => ({ status: 'sent', provider: 'test', providerMessageId: 'p1' }) });
  const result = await new AdminInboxService(db, delivery).sendHumanMessage('v', 'জি ভাই');
  assert.equal(result.role, 'HUMAN'); assert.equal(result.metadata.delivery.status, 'sent'); assert.equal(logged.type, 'ADMIN_HUMAN_REPLY');
});
test('human reply is rejected when conversation is AI active', async () => {
  const db: any = { conversation: { findUnique: async () => ({ status: 'ACTIVE', customer: {} }) } };
  await assert.rejects(() => new AdminInboxService(db).sendHumanMessage('v', 'hello'), /human-owned/i);
});
test('closed conversation can be safely reopened', async () => {
  const conversation: any = { id: 'v', status: 'CLOSED' }; const tx: any = { conversation: { update: async ({ data }: any) => Object.assign(conversation, data) }, systemLog: { create: async () => ({}) } };
  const db: any = { conversation: { findUnique: async () => conversation }, $transaction: async (callback: any) => callback(tx) };
  await new AdminInboxService(db).reopen('v'); assert.equal(conversation.status, 'ACTIVE');
});
test('admin inbox mutations reject unauthorized requests before database access', async () => {
  const { inboxRoutes } = await import('../../inbox/routes/inbox.routes.js');
  const app = Fastify(); app.decorate('prisma', {} as never); await app.register(inboxRoutes);
  const response = await app.inject({ method: 'POST', url: '/api/admin/conversations/11111111-1111-4111-8111-111111111111/messages', payload: { content: 'no' } });
  assert.equal(response.statusCode, 401); await app.close();
});

test('admin closes a conversation and writes a lifecycle log', async () => {
  const conversation: any = { id: 'v', status: 'ACTIVE' }; let logged = '';
  const tx: any = { conversation: { update: async ({ data }: any) => Object.assign(conversation, data) }, systemLog: { create: async ({ data }: any) => { logged = data.type; } } };
  const db: any = {
    conversation: { findUnique: async () => conversation },
    conversationHandover: { findFirst: async () => null },
    $transaction: async (callback: any) => callback(tx),
  };
  await new AdminInboxService(db).close('v'); assert.equal(conversation.status, 'CLOSED'); assert.equal(logged, 'CONVERSATION_CLOSED');
});

test('inbox returns a global unread conversation count', async () => {
  let countCall = 0;
  const db: any = { conversation: { findMany: async () => [], count: async ({ where }: any) => { countCall += 1; return where.unreadForAdmin ? 7 : 0; } } };
  const result = await new AdminInboxService(db).list({ page: 1, limit: 25, filter: 'all' });
  assert.equal(result.unreadTotal, 7); assert.equal(countCall, 2);
});
