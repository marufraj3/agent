import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@alzeena/database';
import type { AIInput, AIResponse } from '../../ai/ai.types.js';
import { extractEntities } from '../../ai/entity-extractor.js';
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
      update: async ({ where, data }: any) => {
        const item = messages.find((message) => message.id === where.id);
        Object.assign(item, data);
        return item;
      },
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
      language: 'bn',
      entities: extractEntities(input.message),
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
  assert.deepEqual(recent.map((item: { content: string }) => item.content), ['two', 'three']);
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

test('voice transcription, additional text, and product context persist across turns', async () => {
  const memory = createMemoryPrisma();
  const ai = new CapturingAI();
  const transcriptions = [
    { text: 'ভাই Messi polo টা কত?', language: 'mixed', confidence: 0.94, duration: 4 },
    { text: 'এইটার XL আছে?', language: 'mixed', confidence: 0.92, duration: 2 },
  ];
  let transcriptionCalls = 0;
  const voice = {
    prepare: async () => ({
      data: Buffer.from('OggS'),
      base64: 'T2dnUw==',
      mimeType: 'audio/ogg',
      sizeBytes: 4,
      duration: 4,
      sha256: `voice-${transcriptionCalls}`,
      source: 'test',
      temporary: true,
    }),
    transcribe: async () => transcriptions[transcriptionCalls++]!,
    isLowConfidence: () => false,
    normalizeProductCodes: async (text: string) => ({
      normalizedText: text,
      verifiedCodes: [],
      productIds: text.includes('Messi') ? [6238] : [],
    }),
  };
  const chat = new ChatService(
    memory.prisma,
    ai as unknown as AIService,
    20,
    5,
    undefined,
    voice as never,
  );

  await chat.send({
    customer: { platform: 'test', platformUserId: 'voice-user' },
    channel: 'test',
    message: 'M size-ও বলবেন',
    audio: {
      type: 'audio',
      url: 'https://example.com/voice-1.ogg',
      mimeType: 'audio/ogg',
      source: 'test',
    },
  });
  await chat.send({
    customer: { platform: 'test', platformUserId: 'voice-user' },
    channel: 'test',
    audio: {
      type: 'audio',
      url: 'https://example.com/voice-2.ogg',
      mimeType: 'audio/ogg',
      source: 'test',
    },
  });

  assert.equal(memory.messages[0]?.messageType, 'AUDIO');
  assert.equal(memory.messages[0]?.metadata.transcription.text, 'ভাই Messi polo টা কত?');
  assert.match(ai.inputs[0]?.message ?? '', /Additional written context: M size-ও বলবেন/);
  assert.deepEqual(ai.inputs[0]?.contextProductIds, [6238]);
  assert.deepEqual(ai.inputs[1]?.contextProductIds, [6238]);
});

test('reuses a persisted transcription for duplicate audio in the same conversation', async () => {
  const memory = createMemoryPrisma();
  const ai = new CapturingAI();
  let calls = 0;
  const voice = {
    prepare: async () => ({
      data: Buffer.from('OggS'), base64: 'T2dnUw==', mimeType: 'audio/ogg', sizeBytes: 4,
      duration: 2, sha256: 'same-audio-hash', source: 'test', temporary: true,
    }),
    transcribe: async () => {
      calls += 1;
      return { text: 'Messi polo কত?', language: 'mixed', confidence: 0.95, duration: 2 };
    },
    isLowConfidence: () => false,
    normalizeProductCodes: async (text: string) => ({ normalizedText: text, verifiedCodes: [], productIds: [6238] }),
  };
  const chat = new ChatService(memory.prisma, ai as unknown as AIService, 20, 5, undefined, voice as never);
  const input = {
    customer: { platform: 'test', platformUserId: 'duplicate-voice-user' },
    channel: 'test' as const,
    audio: { type: 'audio' as const, url: 'https://example.com/same.ogg', source: 'test' },
  };
  await chat.send(input);
  await chat.send(input);
  assert.equal(calls, 1);
});

test('failed voice transcription returns clarification without calling the AI core', async () => {
  const memory = createMemoryPrisma();
  const ai = new CapturingAI();
  const voice = {
    prepare: async () => ({
      data: Buffer.from('OggS'), base64: 'T2dnUw==', mimeType: 'audio/ogg', sizeBytes: 4,
      duration: null, sha256: 'failed-voice', source: 'test', temporary: true,
    }),
    transcribe: async () => { throw new Error('provider failed'); },
    isLowConfidence: () => false,
    normalizeProductCodes: async (text: string) => ({ normalizedText: text, verifiedCodes: [], productIds: [] }),
  };
  const chat = new ChatService(memory.prisma, ai as unknown as AIService, 20, 5, undefined, voice as never);
  const result = await chat.send({
    customer: { platform: 'test', platformUserId: 'failed-voice-user' },
    channel: 'test',
    audio: { type: 'audio', url: 'https://example.com/failed.ogg', source: 'test' },
  });

  assert.equal(result.requiresHuman, false);
  assert.equal(result.action, 'request_voice_clarification');
  assert.equal(ai.inputs.length, 0);
  assert.equal(memory.messages[0]?.metadata.transcription.status, 'failed');
});

test('low-confidence voice is preserved but not interpreted by the AI core', async () => {
  const memory = createMemoryPrisma();
  const ai = new CapturingAI();
  let normalizationCalls = 0;
  const voice = {
    prepare: async () => ({
      data: Buffer.from('OggS'), base64: 'T2dnUw==', mimeType: 'audio/ogg', sizeBytes: 4,
      duration: 2, sha256: 'unclear-voice', source: 'test', temporary: true,
    }),
    transcribe: async () => ({ text: 'TX one seventy maybe', language: 'mixed', confidence: 0.4, duration: 2 }),
    isLowConfidence: () => true,
    normalizeProductCodes: async (text: string) => {
      normalizationCalls += 1;
      return { normalizedText: text, verifiedCodes: ['TX170'], productIds: [6238] };
    },
  };
  const chat = new ChatService(memory.prisma, ai as unknown as AIService, 20, 5, undefined, voice as never);
  const result = await chat.send({
    customer: { platform: 'test', platformUserId: 'unclear-voice-user' },
    channel: 'test',
    audio: { type: 'audio', url: 'https://example.com/unclear.ogg', source: 'test' },
  });

  assert.equal(result.requiresHuman, false);
  assert.equal(result.action, 'request_voice_clarification');
  assert.equal(ai.inputs.length, 0);
  assert.equal(normalizationCalls, 0);
  assert.equal(memory.messages[0]?.metadata.transcription.text, 'TX one seventy maybe');
  assert.deepEqual(memory.messages[0]?.metadata.productIds, []);
});

test('an identified image product is persisted and reused by the next conversation turn', async () => {
  const memory = createMemoryPrisma();
  const ai = new CapturingAI();
  const imageProducts = {
    identify: async () => ({
      image: { mimeType: 'image/webp', sizeBytes: 1_024, source: 'test', temporary: true },
      analysis: {
        productName: 'TX170 Messi Fan Edition Polo',
        productCode: 'TX170',
        brand: 'Adidas',
        category: 'Mens Fashion',
        subCategory: 'Polo',
        color: 'Blue',
        visibleText: ['TX170'],
        designKeywords: ['Messi'],
        sizeVisible: null,
        priceVisible: '1250',
        confidence: 0.96,
      },
      analysisStatus: 'completed',
      confidenceLevel: 'high',
      matches: [
        {
          productId: 6238,
          score: 0.96,
          reasons: ['product_code_exact', 'product_name_exact'],
          product: { id: 6238 },
          availability: { id: 6238, sizes: [] },
        },
      ],
      selectedProduct: {
        productId: 6238,
        score: 0.96,
        reasons: ['product_code_exact', 'product_name_exact'],
        product: { id: 6238 },
        availability: { id: 6238, sizes: [] },
      },
    }),
  };
  const chat = new ChatService(
    memory.prisma,
    ai as unknown as AIService,
    20,
    5,
    imageProducts as never,
  );

  await chat.send({
    customer: { platform: 'test', platformUserId: 'image-user' },
    channel: 'test',
    message: 'এটার দাম কত?',
    image: {
      type: 'image',
      url: 'https://example.com/tx170.webp',
      mimeType: 'image/webp',
      source: 'test',
    },
  });
  await chat.send({
    customer: { platform: 'test', platformUserId: 'image-user' },
    channel: 'test',
    message: 'M size আছে?',
  });

  assert.equal(memory.messages[0]?.messageType, 'IMAGE');
  assert.deepEqual(memory.messages[0]?.metadata.productIds, [6238]);
  assert.equal(ai.inputs[0]?.message, 'এটার দাম কত?');
  assert.deepEqual(ai.inputs[0]?.contextProductIds, [6238]);
  assert.deepEqual(ai.inputs[1]?.contextProductIds, [6238]);
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

test('AI lock saves customer messages but does not call AI while conversation is human', async () => {
  const memory = createMemoryPrisma();
  const customer = await new CustomerService(memory.prisma).findOrCreateCustomer({ platform: 'test', platformUserId: 'human-lock', name: 'Rahim' });
  const conversation = await new ConversationService(memory.prisma).createConversation({ customerId: customer.id, channel: 'test' });
  await new ConversationService(memory.prisma).markConversationHuman(conversation.id);
  const ai = new CapturingAI();
  const result = await new ChatService(memory.prisma, ai as unknown as AIService, 20, 5).send({
    customer: { platform: 'test', platformUserId: 'human-lock' }, channel: 'test', conversationId: conversation.id, message: 'আরও একটি প্রশ্ন',
  });
  assert.equal(ai.inputs.length, 0); assert.equal(result.reply, null); assert.equal(result.conversationStatus, 'human');
  assert.equal(memory.messages.filter((message) => message.role === 'USER').length, 1);
  assert.equal(memory.messages.filter((message) => message.role === 'ASSISTANT').length, 0);
  assert.equal(memory.conversations[0].unreadForAdmin, true);
});

test('AI responds to the next customer message after admin returns conversation to active', async () => {
  const memory = createMemoryPrisma();
  const customer = await new CustomerService(memory.prisma).findOrCreateCustomer({ platform: 'test', platformUserId: 'return-ai', name: 'Rahim' });
  const conversation = await new ConversationService(memory.prisma).createConversation({ customerId: customer.id, channel: 'test' });
  await new ConversationService(memory.prisma).markConversationHuman(conversation.id);
  await memory.prisma.conversation.update({ where: { id: conversation.id }, data: { status: 'ACTIVE' } });
  const ai = new CapturingAI();
  const result = await new ChatService(memory.prisma, ai as unknown as AIService, 20, 5).send({
    customer: { platform: 'test', platformUserId: 'return-ai' }, channel: 'test', conversationId: conversation.id, message: 'দাম কত?',
  });
  assert.equal(ai.inputs.length, 1); assert.equal(result.conversationStatus, 'active'); assert.equal(typeof result.reply, 'string');
});
