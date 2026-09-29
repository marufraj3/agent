import type { PrismaClient } from '@alzeena/database';
import type { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { RecommendationService, defaultRecommendationConfig, type RecommendationConfig } from './recommendation.service.js';

export function createRecommendationService(prisma: PrismaClient, redis?: Redis, override?: RecommendationConfig): RecommendationService {
  return new RecommendationService(prisma, redis, override ?? {
    ...defaultRecommendationConfig,
    enabled: env.RECOMMENDATION_ENABLED,
    maxRecommendations: env.RECOMMENDATION_MAX_PRODUCTS,
    crossSellEnabled: env.RECOMMENDATION_CROSS_SELL_ENABLED,
    upsellEnabled: env.RECOMMENDATION_UPSELL_ENABLED,
    cacheTtlSeconds: env.RECOMMENDATION_CACHE_TTL_SECONDS,
  });
}
