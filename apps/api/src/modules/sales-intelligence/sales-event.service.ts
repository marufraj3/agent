import type { PrismaClient } from '@alzeena/database';

export type SalesEventType =
  | 'PRODUCT_VIEWED' | 'PRODUCT_SEARCHED' | 'PRODUCT_RECOMMENDED' | 'PRODUCT_INTEREST'
  | 'PRODUCT_SELECTED' | 'PRODUCT_ADDED' | 'SIZE_CHECKED' | 'PRICE_CHECKED'
  | 'ORDER_STARTED' | 'CUSTOMER_INFO_PROVIDED' | 'ORDER_DRAFT_CREATED'
  | 'ORDER_CONFIRMATION_REQUESTED' | 'ORDER_CONFIRMED' | 'ORDER_SUBMITTED'
  | 'ORDER_CANCELLED' | 'ORDER_COMPLETED' | 'HUMAN_HANDOVER'
  | 'CONVERSATION_CLOSED' | 'ABANDONED_ORDER';

export interface RecordSalesEventInput {
  customerId: string;
  conversationId?: string;
  orderId?: string;
  productId?: string;
  type: SalesEventType;
  summary: string;
  metadata?: Record<string, unknown>;
}

const allowedMetadata = new Set([
  'websiteProductId', 'productCode', 'category', 'size', 'color', 'minPrice', 'maxPrice',
  'intent', 'source', 'recommendationCount', 'reason', 'quantity', 'range',
]);

function safeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata).filter(([key, value]) => {
    if (!allowedMetadata.has(key)) return false;
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export class SalesEventService {
  private readonly db: any;
  constructor(prisma: PrismaClient) { this.db = prisma as any; }

  async record(input: RecordSalesEventInput): Promise<void> {
    await this.db.customerActivity.create({
      data: {
        customerId: input.customerId,
        conversationId: input.conversationId,
        orderId: input.orderId,
        productId: input.productId,
        requestedSize: typeof input.metadata?.size === 'string' ? input.metadata.size.slice(0, 50) : undefined,
        minPrice: typeof input.metadata?.minPrice === 'number' ? input.metadata.minPrice : undefined,
        maxPrice: typeof input.metadata?.maxPrice === 'number' ? input.metadata.maxPrice : undefined,
        type: input.type,
        summary: input.summary.slice(0, 500),
        metadata: safeMetadata(input.metadata),
      },
    });
  }

  async recordRecommendations(input: Omit<RecordSalesEventInput, 'type' | 'summary' | 'productId'> & { products: Array<{ internalProductId: string; productId: number; productCode: string; category: string | null }>; source: string }): Promise<void> {
    await Promise.all(input.products.slice(0, 5).map((product) => this.record({
      customerId: input.customerId,
      conversationId: input.conversationId,
      type: 'PRODUCT_RECOMMENDED',
      productId: product.internalProductId,
      summary: `Recommended ${product.productCode}`,
      metadata: { websiteProductId: product.productId, productCode: product.productCode, category: product.category, source: input.source },
    })));
  }
}
