import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { requireAdmin } from '../../admin/auth/require-admin.js';
import { dashboardDateRange } from '../../admin/dashboard-range.js';
import { SalesInsightService } from '../sales-insight.service.js';
import { SalesIntelligenceService } from '../sales-intelligence.service.js';

const rangeSchema = z.object({
  range: z.enum(['today', 'yesterday', '7d', '30d', 'custom']).default('7d'),
  from: z.string().max(50).optional(),
  to: z.string().max(50).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export async function salesIntelligenceRoutes(app: FastifyInstance): Promise<void> {
  const service = new SalesIntelligenceService(app.prisma);
  const insights = new SalesInsightService();
  const protectedRoute = { preHandler: requireAdmin };

  function input(request: { query: unknown }) {
    const parsed = rangeSchema.safeParse(request.query);
    if (!parsed.success) throw new AppError('Invalid sales intelligence filter', 400, 'VALIDATION_ERROR');
    const range = dashboardDateRange(parsed.data.range, parsed.data.from, parsed.data.to);
    if (!range) throw new AppError('A valid range of no more than one year is required', 400, 'INVALID_DATE_RANGE');
    return { ...parsed.data, dates: range };
  }

  async function cached<T>(scope: string, keyData: unknown, loader: () => Promise<T>): Promise<T> {
    const digest = createHash('sha256').update(JSON.stringify(keyData)).digest('hex');
    const key = `cache:sales-intelligence:${scope}:${digest}`;
    const hit = await app.redis.get(key).catch(() => null);
    if (hit) try { return JSON.parse(hit) as T; } catch { await app.redis.del(key).catch(() => undefined); }
    const value = await loader();
    await app.redis.set(key, JSON.stringify(value), 'EX', env.SALES_INTELLIGENCE_CACHE_TTL_SECONDS).catch(() => undefined);
    return value;
  }

  app.get('/api/admin/sales-intelligence/overview', protectedRoute, async (request) => {
    const parsed = input(request);
    const data = await cached('overview', parsed, async () => {
      const [overview, trends] = await Promise.all([
        service.overview(parsed.dates), service.trends(parsed.dates),
      ]);
      return { range: { from: parsed.dates.from.toISOString(), to: parsed.dates.to.toISOString() }, overview, trends, insights: insights.summarize(overview, trends) };
    });
    return { success: true, data };
  });

  app.get('/api/admin/sales-intelligence/funnel', protectedRoute, async (request) => {
    const parsed = input(request);
    const data = await cached('funnel', parsed, () => service.funnel(parsed.dates));
    return { success: true, data };
  });

  app.get('/api/admin/sales-intelligence/products', protectedRoute, async (request) => {
    const parsed = input(request);
    const data = await cached('products', parsed, () => service.productPerformance(parsed.dates, parsed.page, parsed.limit));
    return { success: true, data };
  });

  app.get('/api/admin/sales-intelligence/events', protectedRoute, async (request) => {
    const parsed = input(request);
    const data = await service.events(parsed.dates, parsed.page, parsed.limit);
    return { success: true, data };
  });
}
