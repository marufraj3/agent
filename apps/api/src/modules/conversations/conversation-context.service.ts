import type { PrismaClient } from '@alzeena/database';
import type { ConversationMessage } from '../ai/ai.types.js';
import type { CatalogProductWithAvailability, ProductCatalogService } from '../products/product-catalog.service.js';
import { MessageService } from './message.service.js';

export interface ConversationMemoryContext {
  conversation: {
    id: string;
    status: 'active' | 'closed' | 'human';
    channel: 'web' | 'messenger' | 'admin' | 'test';
  };
  customer: {
    id: string;
    name: string | null;
    language: string | null;
  };
  history: ConversationMessage[];
  activeProductIds: number[];
  currentProducts: CatalogProductWithAvailability[];
}

function productIdsFromMetadata(metadata: unknown): number[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const value = metadata as Record<string, unknown>;
  const ids: number[] = [];
  if (typeof value.productId === 'number' && Number.isInteger(value.productId)) ids.push(value.productId);
  if (Array.isArray(value.productIds)) {
    ids.push(
      ...value.productIds.filter(
        (id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0,
      ),
    );
  }
  return ids;
}

export class ConversationContextService {
  private readonly messages: MessageService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly historyLimit: number,
    private readonly catalog?: Pick<ProductCatalogService, 'getProductsWithAvailability'>,
  ) {
    this.messages = new MessageService(prisma);
  }

  async buildContext(
    conversationId: string,
    options: { excludeMessageId?: string; maxProductIds?: number } = {},
  ): Promise<ConversationMemoryContext | null> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { customer: true },
    });
    if (!conversation) return null;

    const recent = await this.messages.getRecentMessages(
      conversationId,
      this.historyLimit + (options.excludeMessageId ? 1 : 0),
    );
    const included = recent.filter((message) => message.id !== options.excludeMessageId);
    const history = included.flatMap<ConversationMessage>((message) => {
      if (message.role === 'USER') return [{ role: 'user', content: message.content }];
      if (message.role === 'ASSISTANT' || message.role === 'HUMAN') {
        return [{ role: 'assistant', content: message.content }];
      }
      return [];
    });

    const activeProductIds: number[] = [];
    for (const message of [...included].reverse()) {
      for (const productId of productIdsFromMetadata(message.metadata)) {
        if (!activeProductIds.includes(productId)) activeProductIds.push(productId);
        if (activeProductIds.length >= (options.maxProductIds ?? 5)) break;
      }
      if (activeProductIds.length >= (options.maxProductIds ?? 5)) break;
    }

    const currentProducts = this.catalog
      ? await this.catalog.getProductsWithAvailability(activeProductIds)
      : [];

    return {
      conversation: {
        id: conversation.id,
        status: conversation.status.toLowerCase() as ConversationMemoryContext['conversation']['status'],
        channel: conversation.channel.toLowerCase() as ConversationMemoryContext['conversation']['channel'],
      },
      customer: {
        id: conversation.customer.id,
        name: conversation.customer.name,
        language: conversation.customer.language,
      },
      history,
      activeProductIds,
      currentProducts,
    };
  }
}
