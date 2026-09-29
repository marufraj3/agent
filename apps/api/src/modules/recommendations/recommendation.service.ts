import { createHash } from 'node:crypto';
import type { PrismaClient } from '@alzeena/database';
import type { Redis } from 'ioredis';
import { resolveEffectivePrice, type PriceValue } from '../products/effective-price.js';

export type RecommendationReason =
  | 'exact_code'
  | 'keyword_match'
  | 'category_match'
  | 'color_match'
  | 'price_match'
  | 'size_available'
  | 'currently_available'
  | 'pre_order_available'
  | 'conversation_relevance'
  | 'preference_match'
  | 'similar_product'
  | 'slightly_above_budget';

export interface RecommendationFilters {
  query?: string | null;
  category?: string | null;
  color?: string | null;
  size?: string | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  contextProductIds?: number[];
  preferredProductIds?: number[];
  excludeProductIds?: number[];
  mode?: 'recommendation' | 'cross_sell' | 'similar';
}

export interface RecommendedProduct {
  productId: number;
  internalProductId: string;
  productName: string;
  productCode: string;
  category: string | null;
  subCategory: string | null;
  color: string | null;
  details: string | null;
  image: string | null;
  currentPrice: string;
  isPreOrder: boolean;
  requestedSize: { sizeName: string; orderable: boolean; stock: number; availability: 'in_stock' | 'pre_order' | 'unavailable' } | null;
  availableSizes: Array<{ sizeName: string; stock: number; availability: 'in_stock' | 'pre_order' }>;
  relevance: 'high' | 'medium';
  reasons: RecommendationReason[];
  /** Internal only. API/customer response serializers must omit this value. */
  score: number;
}

export interface RecommendationConfig {
  enabled: boolean;
  maxRecommendations: number;
  crossSellEnabled: boolean;
  upsellEnabled: boolean;
  cacheTtlSeconds: number;
  upsellMaximumPercent: number;
  weights: {
    exactCode: number; keyword: number; category: number; color: number; price: number;
    size: number; availability: number; context: number; preference: number;
  };
}

export const defaultRecommendationConfig: RecommendationConfig = {
  enabled: true,
  maxRecommendations: 3,
  crossSellEnabled: true,
  upsellEnabled: true,
  cacheTtlSeconds: 60,
  upsellMaximumPercent: 20,
  weights: { exactCode: 100, keyword: 30, category: 25, color: 18, price: 20, size: 30, availability: 15, context: 20, preference: 12 },
};

function boundedNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function formatPrice(value: PriceValue): string {
  const [whole, fraction = ''] = value.toString().split('.');
  return `${whole}.${`${fraction}00`.slice(0, 2)}`;
}

export class RecommendationService {
  private readonly db: any;
  constructor(
    prisma: PrismaClient,
    private readonly redis?: Redis,
    private readonly config: RecommendationConfig = defaultRecommendationConfig,
  ) { this.db = prisma as any; }

  async recommend(filters: RecommendationFilters): Promise<RecommendedProduct[]> {
    if (!this.config.enabled || (filters.mode === 'cross_sell' && !this.config.crossSellEnabled)) return [];
    const safe = this.normalize(filters);
    const cached = await this.fromCache(safe);
    if (cached) return cached;

    const query = safe.query?.toLowerCase() ?? null;
    const maximumCandidatePrice = safe.maxPrice !== null && this.config.upsellEnabled
      ? safe.maxPrice * (1 + this.config.upsellMaximumPercent / 100)
      : safe.maxPrice;
    const conditions: any[] = [
      { presentInFeed: true },
      { productStatus: '1' },
      ...(safe.excludeProductIds.length ? [{ websiteProductId: { notIn: safe.excludeProductIds } }] : []),
      ...(safe.category ? [{ categoryName: { contains: safe.category, mode: 'insensitive' } }] : []),
      ...(safe.color ? [{ colorName: { contains: safe.color, mode: 'insensitive' } }] : []),
      ...(query ? [{ OR: [
        { productCode: { contains: query, mode: 'insensitive' } },
        { productName: { contains: query, mode: 'insensitive' } },
        { categoryName: { contains: query, mode: 'insensitive' } },
        { subCategoryName: { contains: query, mode: 'insensitive' } },
        { productDetails: { contains: query, mode: 'insensitive' } },
      ] }] : []),
      safe.size ? { OR: [
        { isPreOrder: true, variations: { some: { active: true, sizeName: { equals: safe.size, mode: 'insensitive' } } } },
        { variations: { some: { active: true, sizeName: { equals: safe.size, mode: 'insensitive' }, stockQuantity: { gt: 0 } } } },
      ] } : { OR: [
        { isPreOrder: true, variations: { some: { active: true } } },
        { variations: { some: { active: true, stockQuantity: { gt: 0 } } } },
      ] },
    ];
    const where = { AND: conditions };
    const rows = await this.db.product.findMany({
      where,
      include: { variations: { where: { active: true }, orderBy: [{ stockQuantity: 'desc' }, { sizeName: 'asc' }] } },
      orderBy: [{ updatedAt: 'desc' }],
      take: 60,
    });

    const candidates = rows.flatMap((row: any) => {
      const currentPrice = Number(resolveEffectivePrice(row));
      if (!Number.isFinite(currentPrice)) return [];
      if (safe.minPrice !== null && currentPrice < safe.minPrice) return [];
      if (maximumCandidatePrice !== null && currentPrice > maximumCandidatePrice) return [];
      const overBudget = safe.maxPrice !== null && currentPrice > safe.maxPrice;
      const requestedVariation = safe.size
        ? row.variations.find((variation: any) => variation.sizeName.toUpperCase() === safe.size!.toUpperCase())
        : null;
      if (safe.size && !requestedVariation) return [];
      const requestedOrderable = requestedVariation
        ? requestedVariation.stockQuantity > 0 || row.isPreOrder
        : false;
      if (safe.size && !requestedOrderable) return [];

      const reasons: RecommendationReason[] = [];
      let score = 0;
      const text = `${row.productName} ${row.productCode} ${row.categoryName ?? ''} ${row.subCategoryName ?? ''}`.toLowerCase();
      if (query && row.productCode.toLowerCase() === query) { score += this.config.weights.exactCode; reasons.push('exact_code'); }
      else if (query && text.includes(query)) { score += this.config.weights.keyword; reasons.push('keyword_match'); }
      if (safe.category && row.categoryName?.toLowerCase().includes(safe.category.toLowerCase())) { score += this.config.weights.category; reasons.push('category_match'); }
      if (safe.color && row.colorName?.toLowerCase().includes(safe.color.toLowerCase())) { score += this.config.weights.color; reasons.push('color_match'); }
      if (!overBudget && (safe.minPrice !== null || safe.maxPrice !== null)) { score += this.config.weights.price; reasons.push('price_match'); }
      if (requestedOrderable) { score += this.config.weights.size; reasons.push('size_available'); }
      const inStock = row.variations.some((variation: any) => variation.stockQuantity > 0);
      if (inStock) { score += this.config.weights.availability; reasons.push('currently_available'); }
      else if (row.isPreOrder) { score += Math.floor(this.config.weights.availability / 2); reasons.push('pre_order_available'); }
      if (safe.contextProductIds.includes(row.websiteProductId)) { score += this.config.weights.context; reasons.push('conversation_relevance'); }
      if (safe.preferredProductIds.includes(row.websiteProductId)) { score += this.config.weights.preference; reasons.push('preference_match'); }
      if (safe.mode === 'similar') { score += 8; reasons.push('similar_product'); }
      if (overBudget) { score -= 15; reasons.push('slightly_above_budget'); }

      const availableSizes = row.variations.flatMap((variation: any) => {
        const orderable = variation.stockQuantity > 0 || row.isPreOrder;
        return orderable ? [{
          sizeName: variation.sizeName,
          stock: variation.stockQuantity,
          availability: variation.stockQuantity > 0 ? 'in_stock' as const : 'pre_order' as const,
        }] : [];
      });
      const product: RecommendedProduct = {
        productId: row.websiteProductId,
        internalProductId: row.id,
        productName: row.productName,
        productCode: row.productCode,
        category: row.categoryName,
        subCategory: row.subCategoryName,
        color: row.colorName,
        details: row.productDetails,
        image: row.productImage,
        currentPrice: formatPrice(resolveEffectivePrice(row)),
        isPreOrder: row.isPreOrder,
        requestedSize: requestedVariation ? {
          sizeName: requestedVariation.sizeName,
          orderable: requestedOrderable,
          stock: requestedVariation.stockQuantity,
          availability: requestedVariation.stockQuantity > 0 ? 'in_stock' : row.isPreOrder ? 'pre_order' : 'unavailable',
        } : null,
        availableSizes,
        relevance: score >= 55 ? 'high' : 'medium',
        reasons,
        score,
      };
      return [product];
    });

    candidates.sort((a: RecommendedProduct, b: RecommendedProduct) => b.score - a.score || Number(a.currentPrice) - Number(b.currentPrice) || a.productId - b.productId);
    const withinBudget = candidates.filter((item: RecommendedProduct) => !item.reasons.includes('slightly_above_budget'));
    const upsell = candidates.find((item: RecommendedProduct) => item.reasons.includes('slightly_above_budget'));
    const result = withinBudget.slice(0, this.config.maxRecommendations);
    if (this.config.upsellEnabled && upsell && result.length < this.config.maxRecommendations) result.push(upsell);
    const final = result.slice(0, this.config.maxRecommendations);
    await this.toCache(safe, final);
    return final;
  }

  async compareByCodes(productCodes: string[]): Promise<Array<Omit<RecommendedProduct, 'score' | 'relevance' | 'reasons' | 'requestedSize'>>> {
    const codes = [...new Set(productCodes.map((code) => code.trim()).filter(Boolean))].slice(0, 3);
    if (codes.length < 2) return [];
    const rows = await this.db.product.findMany({
      where: { presentInFeed: true, OR: codes.map((code) => ({ productCode: { contains: code, mode: 'insensitive' } })) },
      select: { websiteProductId: true, productCode: true },
      take: 10,
    });
    const ids = codes.map((code) => {
      const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, '');
      return rows.find((row: any) => row.productCode.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(normalized))?.websiteProductId;
    }).filter(Number.isInteger) as number[];
    return this.compare(ids);
  }

  async compare(websiteProductIds: number[]): Promise<Array<Omit<RecommendedProduct, 'score' | 'relevance' | 'reasons' | 'requestedSize'>>> {
    const ids = [...new Set(websiteProductIds.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 3);
    if (ids.length < 2) return [];
    const rows = await this.db.product.findMany({
      where: { websiteProductId: { in: ids }, presentInFeed: true },
      include: { variations: { where: { active: true }, orderBy: { sizeName: 'asc' } } },
    });
    const byId = new Map(rows.map((row: any) => [row.websiteProductId, row]));
    return ids.flatMap((id) => {
      const row: any = byId.get(id);
      if (!row) return [];
      return [{
        productId: row.websiteProductId, internalProductId: row.id, productName: row.productName,
        productCode: row.productCode, category: row.categoryName, subCategory: row.subCategoryName,
        color: row.colorName, details: row.productDetails, image: row.productImage,
        currentPrice: formatPrice(resolveEffectivePrice(row)), isPreOrder: row.isPreOrder,
        availableSizes: row.variations.flatMap((variation: any) => variation.stockQuantity > 0 || row.isPreOrder ? [{ sizeName: variation.sizeName, stock: variation.stockQuantity, availability: variation.stockQuantity > 0 ? 'in_stock' as const : 'pre_order' as const }] : []),
      }];
    });
  }

  private normalize(filters: RecommendationFilters) {
    return {
      query: filters.query?.trim().slice(0, 100) || null,
      category: filters.category?.trim().slice(0, 100) || null,
      color: filters.color?.trim().slice(0, 50) || null,
      size: filters.size?.trim().toUpperCase().slice(0, 20) || null,
      minPrice: boundedNumber(filters.minPrice),
      maxPrice: boundedNumber(filters.maxPrice),
      contextProductIds: [...new Set(filters.contextProductIds ?? [])].filter(Number.isInteger).slice(0, 10),
      preferredProductIds: [...new Set(filters.preferredProductIds ?? [])].filter(Number.isInteger).slice(0, 10),
      excludeProductIds: [...new Set(filters.excludeProductIds ?? [])].filter(Number.isInteger).slice(0, 20),
      mode: filters.mode ?? 'recommendation' as const,
    };
  }

  private cacheKey(filters: ReturnType<RecommendationService['normalize']>): string {
    const identity = { filters, max: this.config.maxRecommendations, upsell: this.config.upsellEnabled, crossSell: this.config.crossSellEnabled };
    return `cache:recommendation:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
  }

  private async fromCache(filters: ReturnType<RecommendationService['normalize']>): Promise<RecommendedProduct[] | null> {
    if (!this.redis || this.config.cacheTtlSeconds < 1) return null;
    const version = (await this.redis.get('product:cache:version').catch(() => null)) ?? '0';
    const value = await this.redis.get(`${this.cacheKey(filters)}:${version}`).catch(() => null);
    if (!value) return null;
    try { return JSON.parse(value) as RecommendedProduct[]; } catch { return null; }
  }

  private async toCache(filters: ReturnType<RecommendationService['normalize']>, result: RecommendedProduct[]): Promise<void> {
    if (!this.redis || this.config.cacheTtlSeconds < 1) return;
    const version = (await this.redis.get('product:cache:version').catch(() => null)) ?? '0';
    await this.redis.set(`${this.cacheKey(filters)}:${version}`, JSON.stringify(result), 'EX', this.config.cacheTtlSeconds).catch(() => undefined);
  }
}
