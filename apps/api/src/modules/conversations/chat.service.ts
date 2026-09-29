import type { PrismaClient } from '@alzeena/database';
import type { AIService } from '../ai/ai.service.js';
import { ProductCatalogService } from '../products/product-catalog.service.js';
import type { ConversationChannelName } from './conversation.types.js';
import { ConversationContextService } from './conversation-context.service.js';
import { ConversationService } from './conversation.service.js';
import { CustomerService, type CreateCustomerInput } from './customer.service.js';
import { MessageService } from './message.service.js';

export interface ChatInput {
  customer: CreateCustomerInput & {
    platform: string;
    platformUserId: string;
  };
  message: string;
  channel: ConversationChannelName;
  conversationId?: string;
  newConversation?: boolean;
}

export class ConversationAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationAccessError';
  }
}

export class ChatService {
  private readonly customers: CustomerService;
  private readonly conversations: ConversationService;
  private readonly messages: MessageService;
  private readonly context: ConversationContextService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ai: AIService,
    historyLimit: number,
    private readonly maxProductIds: number,
  ) {
    this.customers = new CustomerService(prisma);
    this.conversations = new ConversationService(prisma);
    this.messages = new MessageService(prisma);
    this.context = new ConversationContextService(
      prisma,
      historyLimit,
      new ProductCatalogService(prisma),
    );
  }

  async send(input: ChatInput) {
    const customer = await this.customers.findOrCreateCustomer(input.customer);
    let conversation;

    if (input.newConversation) {
      const active = await this.conversations.getActiveConversation(customer.id, input.channel);
      if (active) await this.conversations.closeConversation(active.id);
      conversation = await this.conversations.createConversation({
        customerId: customer.id,
        channel: input.channel,
      });
    } else if (input.conversationId) {
      const requested = await this.conversations.getConversation(input.conversationId);
      if (!requested || requested.customerId !== customer.id || requested.status !== 'ACTIVE') {
        throw new ConversationAccessError('Conversation is unavailable for this customer');
      }
      conversation = requested;
    } else {
      conversation = await this.conversations.getOrCreateConversation({
        customerId: customer.id,
        channel: input.channel,
      });
    }

    const userMessage = await this.messages.addMessage({
      conversationId: conversation.id,
      customerId: customer.id,
      role: 'user',
      content: input.message,
    });
    const memory = await this.context.buildContext(conversation.id, {
      excludeMessageId: userMessage.id,
      maxProductIds: this.maxProductIds,
    });
    if (!memory) throw new Error('Conversation context could not be built');

    const language = ['bn', 'banglish', 'en'].includes(customer.language ?? '')
      ? (customer.language as 'bn' | 'banglish' | 'en')
      : 'auto';
    const response = await this.ai.respond({
      message: input.message,
      conversationId: conversation.id,
      customerId: customer.id,
      language,
      conversationHistory: memory.history,
      contextProductIds: memory.activeProductIds,
      customerContext: { name: customer.name, language: customer.language },
    });

    await this.messages.addMessage({
      conversationId: conversation.id,
      customerId: customer.id,
      role: 'assistant',
      content: response.reply,
      metadata: {
        intent: response.intent,
        confidence: response.confidence,
        requiresHuman: response.requiresHuman,
        action: response.action,
        productIds: response.productIds,
        products: response.products.map((product) => ({
          id: product.id,
          productCode: product.productCode,
        })),
        source: response.source,
      },
    });
    if (response.requiresHuman) {
      await this.conversations.markConversationHuman(conversation.id);
    }

    return {
      conversationId: conversation.id,
      customerId: customer.id,
      conversationStatus: response.requiresHuman ? ('human' as const) : ('active' as const),
      ...response,
    };
  }
}
