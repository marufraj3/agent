import type { PrismaClient } from '@alzeena/database';
import type { ShoppingIntent } from './shopping-intent.service.js';

export interface CustomerPreferenceMemory {
  preferredCategory: string | null;
  preferredSize: string | null;
  preferredColor: string | null;
  preferredMinPrice: number | null;
  preferredMaxPrice: number | null;
  preferredLanguage: string | null;
  lastShoppingIntent: string | null;
  viewedProductIds: number[];
  orderedProductIds: number[];
  discussedProductIds: number[];
}

export class CustomerPreferenceService {
  private readonly db: any;
  constructor(prisma: PrismaClient) { this.db = prisma as any; }

  async rememberExplicit(customerId: string, message: string, intent: ShoppingIntent): Promise<void> {
    const explicitPreference = /(?:usually|normally|prefer|my (?:size|color|colour|budget)|সাধারণত|আমার সাইজ|আমার পছন্দ|পছন্দ করি|আমার বাজেট)/iu.test(message);
    const data: Record<string, unknown> = { lastShoppingIntent: intent.primary };
    if (explicitPreference) {
      if (intent.filters.category) data.preferredCategory = intent.filters.category;
      if (intent.filters.size) data.preferredSize = intent.filters.size;
      if (intent.filters.color) data.preferredColor = intent.filters.color;
      if (intent.filters.minPrice !== null) data.preferredMinPrice = intent.filters.minPrice;
      if (intent.filters.maxPrice !== null) data.preferredMaxPrice = intent.filters.maxPrice;
      data.preferencesUpdatedAt = new Date();
    }
    await this.db.customer.update({ where: { id: customerId }, data });
  }

  async getMemory(customerId: string): Promise<CustomerPreferenceMemory | null> {
    const customer = await this.db.customer.findUnique({
      where: { id: customerId },
      select: {
        preferredCategory: true, preferredSize: true, preferredColor: true,
        preferredMinPrice: true, preferredMaxPrice: true, language: true,
        lastShoppingIntent: true,
      },
    });
    if (!customer) return null;
    const [activities, ordered] = await Promise.all([
      this.db.customerActivity.findMany({
        where: { customerId, productId: { not: null }, type: { in: ['PRODUCT_VIEWED', 'PRODUCT_INTEREST', 'PRODUCT_SEARCHED', 'PRODUCT_RECOMMENDED'] } },
        select: { product: { select: { websiteProductId: true } }, type: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.db.orderItem.findMany({
        where: { order: { is: { customerId, status: { in: ['CONFIRMED', 'SUBMITTED', 'COMPLETED'] } } } },
        select: { websiteProductId: true },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    ]);
    const ids = (types: string[]) => [...new Set(activities.filter((item: any) => types.includes(item.type)).map((item: any) => item.product?.websiteProductId).filter(Number.isInteger))].slice(0, 10) as number[];
    return {
      preferredCategory: customer.preferredCategory,
      preferredSize: customer.preferredSize,
      preferredColor: customer.preferredColor,
      preferredMinPrice: customer.preferredMinPrice === null ? null : Number(customer.preferredMinPrice),
      preferredMaxPrice: customer.preferredMaxPrice === null ? null : Number(customer.preferredMaxPrice),
      preferredLanguage: customer.language,
      lastShoppingIntent: customer.lastShoppingIntent,
      viewedProductIds: ids(['PRODUCT_VIEWED']),
      discussedProductIds: ids(['PRODUCT_INTEREST', 'PRODUCT_SEARCHED', 'PRODUCT_RECOMMENDED']),
      orderedProductIds: [...new Set(ordered.map((item: any) => item.websiteProductId))].slice(0, 10) as number[],
    };
  }
}
