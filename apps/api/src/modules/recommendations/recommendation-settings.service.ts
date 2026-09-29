import type { PrismaClient } from '@alzeena/database';
import { defaultRecommendationConfig, type RecommendationConfig } from './recommendation.service.js';

export interface RecommendationControls {
  enabled: boolean;
  maxRecommendations: number;
  crossSellEnabled: boolean;
  upsellEnabled: boolean;
  cacheTtlSeconds: number;
}

export const defaultRecommendationControls: RecommendationControls = {
  enabled: true,
  maxRecommendations: 3,
  crossSellEnabled: true,
  upsellEnabled: true,
  cacheTtlSeconds: 60,
};

const keys = {
  enabled: 'recommendation.enabled',
  maxRecommendations: 'recommendation.max_products',
  crossSellEnabled: 'recommendation.cross_sell_enabled',
  upsellEnabled: 'recommendation.upsell_enabled',
  cacheTtlSeconds: 'recommendation.cache_ttl_seconds',
} as const;

export class RecommendationSettingsService {
  private readonly db: any;
  constructor(prisma: PrismaClient, private readonly defaults = defaultRecommendationControls) { this.db = prisma as any; }

  async get(): Promise<RecommendationControls> {
    const rows = await this.db.setting.findMany({ where: { key: { in: Object.values(keys) } }, select: { key: true, value: true } });
    const values = new Map(rows.map((row: any) => [row.key, row.value]));
    const integer = Number(values.get(keys.maxRecommendations));
    const ttl = Number(values.get(keys.cacheTtlSeconds));
    const bool = (key: string, fallback: boolean) => values.has(key) ? values.get(key) === 'true' : fallback;
    return {
      enabled: bool(keys.enabled, this.defaults.enabled),
      maxRecommendations: Number.isInteger(integer) && integer >= 1 && integer <= 3 ? integer : this.defaults.maxRecommendations,
      crossSellEnabled: bool(keys.crossSellEnabled, this.defaults.crossSellEnabled),
      upsellEnabled: bool(keys.upsellEnabled, this.defaults.upsellEnabled),
      cacheTtlSeconds: Number.isInteger(ttl) && ttl >= 5 && ttl <= 900 ? ttl : this.defaults.cacheTtlSeconds,
    };
  }

  async update(input: RecommendationControls): Promise<RecommendationControls> {
    const entries: Array<[string, string]> = [
      [keys.enabled, String(input.enabled)], [keys.maxRecommendations, String(input.maxRecommendations)],
      [keys.crossSellEnabled, String(input.crossSellEnabled)], [keys.upsellEnabled, String(input.upsellEnabled)],
      [keys.cacheTtlSeconds, String(input.cacheTtlSeconds)],
    ];
    await this.db.$transaction([
      ...entries.map(([key, value]) => this.db.setting.upsert({
        where: { key }, create: { key, value, description: 'Step 20 recommendation control' }, update: { value },
      })),
      this.db.systemLog.create({ data: {
        level: 'INFO', type: 'RECOMMENDATION_SETTINGS_UPDATED', event: 'RECOMMENDATION_SETTINGS_UPDATED', module: 'recommendations',
        message: 'Admin updated recommendation controls', metadata: { keys: entries.map(([key]) => key), timestamp: new Date().toISOString() },
      } }),
    ]);
    return this.get();
  }

  toEngineConfig(controls: RecommendationControls): RecommendationConfig {
    return { ...defaultRecommendationConfig, ...controls };
  }
}
