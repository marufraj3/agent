import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@alzeena/database';
import Fastify from 'fastify';
import {
  knowledgeBaseUpdateSchema,
  MAX_KNOWLEDGE_BASE_LENGTH,
  settingsUpdateSchema,
} from '../admin.schemas.js';
import { isAdminPasswordValid } from '../auth/admin-password.js';
import { KnowledgeBaseService } from '../knowledge-base.service.js';

process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_PASSWORD = 'a-secure-admin-password';

test('Knowledge Base validation rejects empty and oversized content without trimming valid text', () => {
  assert.equal(knowledgeBaseUpdateSchema.safeParse({ content: '   ' }).success, false);
  assert.equal(
    knowledgeBaseUpdateSchema.safeParse({ content: 'a'.repeat(MAX_KNOWLEDGE_BASE_LENGTH + 1) }).success,
    false,
  );

  const content = '  Keep intentional spacing\n';
  const parsed = knowledgeBaseUpdateSchema.parse({ content });
  assert.equal(parsed.content, content);
});

test('settings validation accepts known values and rejects secret or unknown fields', () => {
  const parsed = settingsUpdateSchema.parse({
    deliveryChargeDhaka: '70.00',
    pageId: '3',
    websiteApiBaseUrl: 'https://sells.alzeena.com.bd/public/api',
  });
  assert.equal(parsed.deliveryChargeDhaka, '70');

  assert.equal(settingsUpdateSchema.safeParse({ geminiApiKey: 'secret' }).success, false);
  assert.equal(settingsUpdateSchema.safeParse({ deliveryChargeDhaka: '-1' }).success, false);
});

test('admin password comparison rejects absent and incorrect credentials', () => {
  assert.equal(isAdminPasswordValid(undefined, process.env.ADMIN_PASSWORD), false);
  assert.equal(isAdminPasswordValid('wrong-password', process.env.ADMIN_PASSWORD), false);
  assert.equal(isAdminPasswordValid(process.env.ADMIN_PASSWORD, process.env.ADMIN_PASSWORD), true);
});

test('Knowledge Base save increments version, preserves history state and omits content from logs', async () => {
  const previous = { id: 'kb-1', version: 1, isActive: true };
  const logs: unknown[] = [];
  const transaction = {
    knowledgeBase: {
      findFirst: async () => ({ id: previous.id, version: previous.version }),
      aggregate: async () => ({ _max: { version: 1 } }),
      update: async () => {
        previous.isActive = false;
        return previous;
      },
      create: async ({ data }: { data: { content: string; version: number } }) => ({
        content: data.content,
        version: data.version,
        updatedAt: new Date('2026-09-29T12:00:00.000Z'),
      }),
    },
    systemLog: {
      create: async ({ data }: { data: unknown }) => {
        logs.push(data);
        return data;
      },
    },
  };
  const fakePrisma = {
    $transaction: async (callback: (client: typeof transaction) => unknown) => callback(transaction),
  } as unknown as PrismaClient;

  const content = 'A private instruction that must not be logged';
  const result = await new KnowledgeBaseService(fakePrisma).updateKnowledgeBase(content);

  assert.equal(result.version, 2);
  assert.equal(result.content, content);
  assert.equal(previous.isActive, false);
  assert.equal(logs.length, 1);
  assert.equal(JSON.stringify(logs).includes(content), false);
});

test('Knowledge Base API denies unauthenticated requests before database access', async () => {
  const { adminRoutes } = await import('../routes/admin.routes.js');
  const app = Fastify();
  app.decorate('prisma', {} as never);
  await app.register(adminRoutes);

  const getResponse = await app.inject({ method: 'GET', url: '/api/admin/knowledge-base' });
  const putResponse = await app.inject({
    method: 'PUT',
    url: '/api/admin/knowledge-base',
    payload: { content: 'Should not be written' },
  });
  const settingsResponse = await app.inject({ method: 'GET', url: '/api/admin/settings' });

  assert.equal(getResponse.statusCode, 401);
  assert.equal(putResponse.statusCode, 401);
  assert.equal(settingsResponse.statusCode, 401);
  await app.close();
});

test('AI endpoints deny unauthenticated requests before AI or database access', async () => {
  const [{ aiTestRoutes }, { chatRoutes }] = await Promise.all([
    import('../../ai/routes/ai-test.routes.js'),
    import('../../conversations/routes/chat.routes.js'),
  ]);
  const app = Fastify();
  app.decorate('prisma', {} as never);
  await app.register(aiTestRoutes);
  await app.register(chatRoutes);

  const testResponse = await app.inject({
    method: 'POST',
    url: '/api/ai/test',
    payload: { message: 'Hello' },
  });
  const chatResponse = await app.inject({
    method: 'POST',
    url: '/api/ai/chat',
    payload: {
      customer: { platform: 'test', platformUserId: 'unauthenticated' },
      message: 'Hello',
    },
  });

  assert.equal(testResponse.statusCode, 401);
  assert.equal(chatResponse.statusCode, 401);
  await app.close();
});
