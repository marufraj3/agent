import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../../errors/app-error.js';
import { env } from '../../../config/env.js';
import { requireAdmin } from '../../admin/auth/require-admin.js';
import { createRecommendationService } from '../recommendation.factory.js';
import { RecommendationSettingsService } from '../recommendation-settings.service.js';

const optionalPrice = z.preprocess((value) => value === '' || value === undefined ? undefined : Number(value), z.number().nonnegative().max(10_000_000).optional());
const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(),
  color: z.string().trim().max(50).optional(),
  size: z.enum(['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']).optional(),
  minPrice: optionalPrice,
  maxPrice: optionalPrice,
  mode: z.enum(['recommendation', 'cross_sell', 'similar']).default('recommendation'),
}).strict().refine((value) => value.minPrice === undefined || value.maxPrice === undefined || value.minPrice <= value.maxPrice, 'Invalid price range');

const controlsSchema = z.object({
  enabled: z.boolean(),
  maxRecommendations: z.number().int().min(1).max(3),
  crossSellEnabled: z.boolean(),
  upsellEnabled: z.boolean(),
  cacheTtlSeconds: z.number().int().min(5).max(900),
}).strict();

const previewSchema = querySchema.extend({
  contextProductIds: z.array(z.number().int().positive()).max(10).default([]),
  preferredProductIds: z.array(z.number().int().positive()).max(10).default([]),
  excludeProductIds: z.array(z.number().int().positive()).max(20).default([]),
}).strict();

function publicProduct(item: any) {
  const { score: _score, relevance: _relevance, reasons: _reasons, internalProductId: _internal, ...product } = item;
  return product;
}

export async function recommendationRoutes(app: FastifyInstance): Promise<void> {
  const settings = new RecommendationSettingsService(app.prisma, {
    enabled: env.RECOMMENDATION_ENABLED,
    maxRecommendations: env.RECOMMENDATION_MAX_PRODUCTS,
    crossSellEnabled: env.RECOMMENDATION_CROSS_SELL_ENABLED,
    upsellEnabled: env.RECOMMENDATION_UPSELL_ENABLED,
    cacheTtlSeconds: env.RECOMMENDATION_CACHE_TTL_SECONDS,
  });
  const recommendations = async () => {
    const controls = await settings.get();
    return createRecommendationService(app.prisma, app.redis, settings.toEngineConfig(controls));
  };

  app.get('/api/recommendations', async (request) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) throw new AppError('Invalid recommendation filters', 400, 'VALIDATION_ERROR');
    const items = await (await recommendations()).recommend({
      query: parsed.data.q, category: parsed.data.category, color: parsed.data.color,
      size: parsed.data.size, minPrice: parsed.data.minPrice, maxPrice: parsed.data.maxPrice,
      mode: parsed.data.mode,
    });
    return { success: true, data: { products: items.map(publicProduct) } };
  });

  app.post('/api/admin/recommendations/preview', { preHandler: requireAdmin }, async (request) => {
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('Invalid recommendation preview', 400, 'VALIDATION_ERROR');
    const products = await (await recommendations()).recommend({
      query: parsed.data.q, category: parsed.data.category, color: parsed.data.color,
      size: parsed.data.size, minPrice: parsed.data.minPrice, maxPrice: parsed.data.maxPrice,
      mode: parsed.data.mode, contextProductIds: parsed.data.contextProductIds,
      preferredProductIds: parsed.data.preferredProductIds,
      excludeProductIds: parsed.data.excludeProductIds,
    });
    return { success: true, data: { products } };
  });

  app.get('/api/admin/recommendations/settings', { preHandler: requireAdmin }, async () => ({
    success: true,
    data: await settings.get(),
  }));

  app.put('/api/admin/recommendations/settings', { preHandler: requireAdmin }, async (request) => {
    const parsed = controlsSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('Invalid recommendation settings', 400, 'VALIDATION_ERROR');
    return { success: true, data: await settings.update(parsed.data) };
  });

  app.get('/api/recommendations/compare', async (request) => {
    const parsed = z.object({ ids: z.string().max(100) }).strict().safeParse(request.query);
    if (!parsed.success) throw new AppError('Two or three product IDs are required', 400, 'VALIDATION_ERROR');
    const ids = parsed.data.ids.split(',').map(Number);
    if (ids.length < 2 || ids.length > 3 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      throw new AppError('Two or three valid product IDs are required', 400, 'VALIDATION_ERROR');
    }
    const products = await (await recommendations()).compare(ids);
    if (products.length < 2) throw new AppError('Products could not be compared', 404, 'PRODUCT_NOT_FOUND');
    return { success: true, data: { products } };
  });
}
