import type { PrismaClient } from '@alzeena/database';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../../config/env.js';
import { createAIService } from '../ai/ai.factory.js';
import { createVoiceUnderstandingService } from '../audio/audio.factory.js';
import { HumanHandoverService } from '../handovers/human-handover.service.js';
import { createImageProductService } from '../images/image.factory.js';
import { OrderConversationService } from '../orders/order-conversation.service.js';
import { OrderService } from '../orders/order.service.js';
import { ProductCatalogService } from '../products/product-catalog.service.js';
import { WebsiteOrderApiClient } from '../orders/website-order-api.client.js';
import { CustomerJourneyService } from '../automation/customer-journey.service.js';
import { FollowUpService } from '../automation/follow-up.service.js';
import type { createFollowUpQueue } from '../automation/follow-up.queue.js';
import { ChatService } from './chat.service.js';

export function createChatService(prisma: PrismaClient, logger: FastifyBaseLogger | any, followUpQueue?: ReturnType<typeof createFollowUpQueue>) {
  return new ChatService(
    prisma,
    createAIService(prisma, logger),
    env.CONVERSATION_HISTORY_LIMIT,
    env.AI_MAX_PRODUCTS,
    createImageProductService(prisma),
    createVoiceUnderstandingService(prisma),
    new OrderConversationService(
      new OrderService(prisma, new WebsiteOrderApiClient(env.ORDER_API_TIMEOUT_MS), logger),
      new ProductCatalogService(prisma),
    ),
    new HumanHandoverService(prisma),
    env.AI_MAX_CONSECUTIVE_FAILURES,
    env.AI_CONFIDENCE_LOW,
    new CustomerJourneyService(prisma),
    followUpQueue ? new FollowUpService(prisma, followUpQueue) : undefined,
    {
      enabled: env.RECOMMENDATION_ENABLED,
      maxRecommendations: env.RECOMMENDATION_MAX_PRODUCTS,
      crossSellEnabled: env.RECOMMENDATION_CROSS_SELL_ENABLED,
      upsellEnabled: env.RECOMMENDATION_UPSELL_ENABLED,
      cacheTtlSeconds: env.RECOMMENDATION_CACHE_TTL_SECONDS,
    },
  );
}
