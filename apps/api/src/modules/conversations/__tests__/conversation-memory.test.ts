import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@alzeena/database';
import type { AIInput, AIResponse } from '../../ai/ai.types.js';
import type { AIService } from '../../ai/ai.service.js';
import { ChatService } from '../chat.service.js';
import { ConversationContextService } from '../conversation-context.service.js';
import { ConversationService } from '../conversation.service.js';
import { CustomerService } from '../customer.service.js';
import { MessageService } from '../message.service.js';

function createMemoryPrisma() {
  const customers: any[] = [];
  const conversations: any[] = [];
  const messages: any[] = [];
  let clock = Date.now();
  const now = () => new Date(++clock);

  const prisma: any = {
    customer: {
      create: async ({ data }: any) => {
        const item = { id: `customer-${customers.length + 1}`, ...data, createdAt: now(), updatedAt: now() };
        customers.push(item);
        return item;
      },
      upsert: async ({ where, create, update }: any) => {
        const key = where.platform_platformUserId;
        let item = key
          ? customers.find(
              (customer) =>
                customer.platform === key.platform && customer.platformUserId === key.platformUserId,
            )
          : customers.find((customer) => customer.externalId === where.externalId);
        if (item) {
          Object.assign(item, update, { updatedAt: now() });
          return item;
        }
        item = { id: `customer-${customers.length + 1}`, ...create, createdAt: now(), updatedAt: now() };
        customers.push(item);
        return item;
      },
      findUnique: async ({ where }: any) => {
        if (where.id) return customers.find((item) => item.id === where.id) ?? null;
        if (where.externalId) return customers.find((item) => item.externalId === where.externalId) ?? null;
        const key = where.platform_platformUserId;
        return (
          customers.find(
            (item) => item.platform === key?.platform && item.platformUserId === key?.platformUserId,
          ) ?? null
        );
      },
      update: async ({ where, data }: any) => {
        const item = customers.find((customer) => customer.id === where.id);
        Object.assign(item, data, { updatedAt: now() });
        return item;
      },
    },
    conversation: {
      create: async ({ data }: any) => {
        const item = {
          id: `conversation-${conversations.length + 1}`,
          ...data,
          lastMessageAt: now(),
          createdAt: now(),
          updatedAt: now(),
        };
        conversations.push(item);
        return item;
      },
      findFirst: async ({ where }: any) =>
        conversations
          .filter(
            (item) =>
              item.customerId === where.customerId &&
              item.channel === where.channel &&
              item.status === where.status,
          )
          .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())[0] ?? null,
      findUnique: async ({ where, include }: any) => {
        const item = conversations.find((conversation) => conversation.id === where.id);
        if (!item) return null;
        return include?.customer
          ? { ...item, customer: customers.find((customer) => customer.id === item.customerId) }
          : item;
      },
      update: async ({ where, data }: any) => {
        const item = conversations.find((conversation) => conversation.id === where.id);
        Object.assign(item, data, { updatedAt: now() });
        return item;
      },
    },
    product: {
      findMany: async () => [],
    },
    message: {
      create: async ({ data }: any) => {
        const item = { id: `message-${messages.length + 1}`, ...data, createdAt: data.createdAt ?? now() };
        messages.push(item);
        return item;
      },
      findUnique: async ({ where }: any) => messages.find((item) => item.id === where.id) ?? null,
      findMany: async ({ where, orderBy, take }: any) => {
        const items = messages.filter((item) => item.conversationId === where.conversationId);
        const descending = orderBy?.[0]?.createdAt === 'desc';
        items.sort((a, b) =>
          descending
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return items.slice(0, take);
      },
      count: async ({ where }: any) =>
        messages.filter((item) => item.conversationId === where.conversationId).length,
    },
  };
  prisma.$transaction = async (callback: (transaction: any) => unknown) => callback(prisma);
  return { prisma: prisma as PrismaClient, customers, conversations, messages };
}

class CapturingAI {
  inputs: AIInput[] = [];

  async respond(input: AIInput): Promise<AIResponse> {
    this.inputs.push(input);
    return {
      reply: this.inputs.length === 1 ? 'Messi Polo 990 টাকা।' : 'জি, M size আছে।',
      intent: this.inputs.length === 1 ? 'price_inquiry' : 'size_inquiry',
      confidence: 0.99,
      requiresHuman: false,
      action: null,
      productIds: [6238],
      products: [
        { id: 6238, productName: 'Messi Polo', productCode: 'TX170 Argentina', image: null },
      ],
      source: 'rules',
    };
  }
}

test('creates a customer and reuses the same platform identity without duplicates', async () => {
  const memory = createMemoryPrisma();
  const service = new CustomerService(memory.prisma);
  const first = await service.findOrCreateCustomer({ platform: 'test', platformUserId: 'user-001', name: 'Rahim' });
  const second = await service.findOrCreateCustomer({ platform: 'TEST', platformUserId: 'user-001' });
  const found = await service.getCustomerByPlatformUserId('test', 'user-001');

  assert.equal(first.id, second.id);
  assert.equal(found?.id, first.id);
  assert.equal(memory.customers.length, 1);
});

test('creates and reuses an active conversation, then permits a new one after closing', async () => {
  const memory = createMemoryPrisma();
  const customer = await new CustomerService(memory.prisma).createCustomer({ name: 'Rahim' });
  const service = new ConversationService(memory.prisma);
  const first = await service.getOrCreateConversation({ customerId: customer.id, channel: 'test' });
  const reused = await service.getOrCreateConversation({ customerId: customer.id, channel: 'test' });
  assert.equal(reused.id, first.id);

  await service.closeConversation(first.id);
  const next = await service.getOrCreateConversation({ customerId: customer.id, channel: 'test' });
  assert.notEqual(next.id, first.id);
});

test('saves messages and returns only recent messages in chronological order', async () => {
  const memory = createMemoryPrisma();
  const customer = await new CustomerService(memory.prisma).createCustomer({});
  const conversation = await new ConversationService(memory.prisma).createConversation({
    customerId: customer.id,
    channel: 'test',
  });
  const service = new MessageService(memory.prisma);
  await service.addMessage({ conversationId: conversation.id, customerId: customer.id, role: 'user', content: 'one' });
  await service.addMessage({ conversationId: conversation.id, customerId: customer.id, role: 'assistant', content: 'two' });
  await service.addMessage({ conversationId: conversation.id, customerId: customer.id, role: 'user', content: 'three' });

  const recent = await service.getRecentMessages(conversation.id, 2);
  assert.deepEqual(recent.map((item) => item.content), ['two', 'three']);
  assert.equal(await service.countMessages(conversation.id), 3);
});

test('conversation context extracts recent product references from message metadata', async () => {
  const memory = createMemoryPrisma();
  const customer = await new CustomerService(memory.prisma).createCustomer({ name: 'Rahim', language: 'bn' });
  const conversation = await new ConversationService(memory.prisma).createConversation({ customerId: customer.id, channel: 'test' });
  await new MessageService(memory.prisma).addMessage({
    conversationId: conversation.id,
    customerId: customer.id,
    role: 'assistant',
    content: 'Messi polo 990 টাকা।',
    metadata: { productIds: [6238] },
  });

  const catalog = {
    getProductsWithAvailability: async (ids: number[]) =>
      ids.map((id) => ({
        product: { id, productName: 'Messi Polo', sellPrice: '990.00' },
        availability: { id, sizes: [{ sizeName: 'M', stock: 24, orderable: true }] },
      })),
  };
  const context = await new ConversationContextService(
    memory.prisma,
    20,
    catalog as never,
  ).buildContext(conversation.id);
  assert.deepEqual(context?.activeProductIds, [6238]);
  assert.equal(context?.currentProducts[0]?.product.sellPrice, '990.00');
  assert.equal(context?.currentProducts[0]?.availability.sizes[0]?.stock, 24);
  assert.equal(context?.history[0]?.role, 'assistant');
  assert.equal(context?.customer.name, 'Rahim');
});

test('persistent chat passes prior history and product metadata to the existing AI service', async () => {
  const memory = createMemoryPrisma();
  const ai = new CapturingAI();
  const chat = new ChatService(memory.prisma, ai as unknown as AIService, 20, 5);

  const first = await chat.send({
    customer: { platform: 'test', platformUserId: 'persistent-user', name: 'Rahim' },
    channel: 'test',
    message: 'Messi polo কত?',
  });
  const second = await chat.send({
    customer: { platform: 'test', platformUserId: 'persistent-user' },
    channel: 'test',
    message: 'M size আছে?',
  });

  assert.equal(first.customerId, second.customerId);
  assert.equal(first.conversationId, second.conversationId);
  assert.equal(memory.customers.length, 1);
  assert.equal(memory.conversations.length, 1);
  assert.equal(memory.messages.length, 4);
  assert.deepEqual(ai.inputs[1]?.contextProductIds, [6238]);
  assert.equal(ai.inputs[1]?.customerContext?.name, 'Rahim');
  assert.deepEqual(ai.inputs[1]?.conversationHistory.map((item) => item.content), [
    'Messi polo কত?',
    'Messi Polo 990 টাকা।',
  ]);
});
