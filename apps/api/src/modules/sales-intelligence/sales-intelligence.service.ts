import type { PrismaClient } from '@alzeena/database';

export interface IntelligenceRange { from: Date; to: Date }
const activityTypes = [
  'PRODUCT_VIEWED', 'PRODUCT_SEARCHED', 'PRODUCT_RECOMMENDED', 'PRODUCT_INTEREST',
  'PRODUCT_SELECTED', 'PRODUCT_ADDED', 'SIZE_CHECKED', 'PRICE_CHECKED', 'ORDER_STARTED', 'ORDER_CONFIRMATION_REQUESTED', 'ORDER_CONFIRMED',
  'ORDER_SUBMITTED', 'ORDER_COMPLETED', 'ABANDONED_ORDER', 'HUMAN_HANDOVER',
] as const;

export class SalesIntelligenceService {
  private readonly db: any;
  constructor(prisma: PrismaClient) { this.db = prisma as any; }

  async overview(range: IntelligenceRange) {
    const createdAt = { gte: range.from, lt: range.to };
    const [conversations, orders, handovers, groups, recommendationConversations, submittedRecommendationConversations] = await Promise.all([
      this.db.conversation.count({ where: { createdAt } }),
      this.db.order.count({ where: { createdAt } }),
      this.db.conversationHandover.count({ where: { createdAt } }),
      this.db.customerActivity.groupBy({ by: ['type'], where: { createdAt, type: { in: [...activityTypes] } }, _count: { _all: true } }),
      this.db.customerActivity.findMany({ where: { createdAt, type: 'PRODUCT_RECOMMENDED', conversationId: { not: null } }, distinct: ['conversationId'], select: { conversationId: true } }),
      this.db.customerActivity.findMany({ where: { createdAt, type: 'PRODUCT_RECOMMENDED', conversationId: { not: null }, conversation: { is: { orders: { some: { status: { in: ['SUBMITTED', 'COMPLETED'] } } } } } }, distinct: ['conversationId'], select: { conversationId: true } }),
    ]);
    const counts = Object.fromEntries(groups.map((row: any) => [row.type, row._count._all]));
    const recommendationUsage = recommendationConversations.length;
    return {
      conversations,
      productInquiries: (counts.PRODUCT_VIEWED ?? 0) + (counts.PRODUCT_INTEREST ?? 0),
      productSearches: counts.PRODUCT_SEARCHED ?? 0,
      productSelections: counts.PRODUCT_SELECTED ?? 0,
      orders,
      abandonedOrders: counts.ABANDONED_ORDER ?? 0,
      humanHandovers: handovers,
      conversionEvents: Object.values(counts).reduce((sum: number, value) => sum + Number(value), 0),
      recommendationUsage,
      recommendationToOrder: submittedRecommendationConversations.length,
      recommendationToOrderRate: recommendationUsage ? Number((submittedRecommendationConversations.length / recommendationUsage * 100).toFixed(1)) : 0,
    };
  }

  async funnel(range: IntelligenceRange) {
    const createdAt = { gte: range.from, lt: range.to };
    const [conversationsStarted, groups, confirmedOrders, submittedOrders, completedOrders] = await Promise.all([
      this.db.conversation.count({ where: { createdAt } }),
      this.db.customerActivity.groupBy({ by: ['type'], where: { createdAt, type: { in: [...activityTypes] } }, _count: { _all: true } }),
      this.db.order.count({ where: { confirmedAt: createdAt } }),
      this.db.order.count({ where: { createdAt, status: { in: ['SUBMITTED', 'COMPLETED'] } } }),
      this.db.order.count({ where: { createdAt, status: 'COMPLETED' } }),
    ]);
    const counts = Object.fromEntries(groups.map((row: any) => [row.type, row._count._all]));
    return {
      conversationsStarted,
      productInquiries: (counts.PRODUCT_VIEWED ?? 0) + (counts.PRODUCT_INTEREST ?? 0),
      productSearches: counts.PRODUCT_SEARCHED ?? 0,
      productSelections: counts.PRODUCT_SELECTED ?? 0,
      orderStarts: counts.ORDER_STARTED ?? 0,
      confirmationRequests: counts.ORDER_CONFIRMATION_REQUESTED ?? 0,
      confirmedOrders,
      submittedOrders,
      completedOrders,
      abandonedOrders: counts.ABANDONED_ORDER ?? 0,
      humanHandovers: counts.HUMAN_HANDOVER ?? 0,
    };
  }

  async productPerformance(range: IntelligenceRange, page = 1, limit = 25) {
    const createdAt = { gte: range.from, lt: range.to };
    const [eventGroups, orderGroups, selectionGroups] = await Promise.all([
      this.db.customerActivity.groupBy({
        by: ['productId', 'type'],
        where: { createdAt, productId: { not: null }, type: { in: ['PRODUCT_SEARCHED', 'PRODUCT_RECOMMENDED', 'PRODUCT_SELECTED', 'PRODUCT_VIEWED', 'PRODUCT_INTEREST'] } },
        _count: { _all: true },
      }),
      this.db.orderItem.groupBy({
        by: ['productId'],
        where: { order: { is: { createdAt, status: { in: ['CONFIRMED', 'SUBMITTED', 'COMPLETED'] } } } },
        _sum: { quantity: true },
        _count: { orderId: true },
      }),
      this.db.orderItem.groupBy({
        by: ['productId'],
        where: { order: { is: { createdAt, status: { notIn: ['CANCELLED', 'FAILED', 'EXPIRED'] } } } },
        _count: { orderId: true },
      }),
    ]);
    const ids = [...new Set([...eventGroups.map((row: any) => row.productId), ...orderGroups.map((row: any) => row.productId), ...selectionGroups.map((row: any) => row.productId)].filter(Boolean))];
    const products = ids.length ? await this.db.product.findMany({
      where: { id: { in: ids } },
      include: { variations: { where: { active: true }, select: { stockQuantity: true } } },
    }) : [];
    const events = new Map<string, Record<string, number>>();
    for (const row of eventGroups) events.set(row.productId, { ...(events.get(row.productId) ?? {}), [row.type]: row._count._all });
    const orders = new Map(orderGroups.map((row: any) => [row.productId, row]));
    const selections = new Map<string, number>(selectionGroups.map((row: any) => [row.productId, Number(row._count.orderId ?? 0)] as [string, number]));
    const rows = products.map((product: any) => {
      const metric = events.get(product.id) ?? {};
      const order = orders.get(product.id) as any;
      const currentPrice = Number(product.flashSellPrice) > 0 ? product.flashSellPrice : Number(product.discountPrice) > 0 ? product.discountPrice : product.sellPrice;
      return {
        productId: product.websiteProductId, productName: product.productName, productCode: product.productCode,
        category: product.categoryName, searched: metric.PRODUCT_SEARCHED ?? 0,
        recommended: metric.PRODUCT_RECOMMENDED ?? 0, selected: Math.max(metric.PRODUCT_SELECTED ?? 0, selections.get(product.id) ?? 0),
        discussed: (metric.PRODUCT_VIEWED ?? 0) + (metric.PRODUCT_INTEREST ?? 0),
        orderQuantity: order?._sum.quantity ?? 0, orders: order?._count.orderId ?? 0,
        currentStock: product.variations.reduce((sum: number, item: any) => sum + item.stockQuantity, 0),
        currentPrice: currentPrice.toFixed(2), isPreOrder: product.isPreOrder,
      };
    }).sort((a: any, b: any) => b.orderQuantity - a.orderQuantity || b.selected - a.selected || b.recommended - a.recommended);
    return { items: rows.slice((page - 1) * limit, page * limit), page, limit, total: rows.length, pages: Math.ceil(rows.length / limit) };
  }

  async trends(range: IntelligenceRange) {
    const createdAt = { gte: range.from, lt: range.to };
    const [productGroups, sizeGroups, rangeRows, orderGroups] = await Promise.all([
      this.db.customerActivity.groupBy({ by: ['productId', 'type'], where: { createdAt, productId: { not: null }, type: { in: ['PRODUCT_SEARCHED', 'PRODUCT_VIEWED', 'PRODUCT_INTEREST', 'PRODUCT_RECOMMENDED'] } }, _count: { _all: true } }),
      this.db.customerActivity.groupBy({ by: ['requestedSize'], where: { createdAt, requestedSize: { not: null } }, _count: { _all: true }, orderBy: { _count: { requestedSize: 'desc' } }, take: 10 }),
      this.db.customerActivity.groupBy({ by: ['minPrice', 'maxPrice'], where: { createdAt, type: 'PRODUCT_SEARCHED', OR: [{ minPrice: { not: null } }, { maxPrice: { not: null } }] }, _count: { _all: true } }),
      this.db.orderItem.groupBy({ by: ['productId'], where: { order: { is: { createdAt, status: { in: ['CONFIRMED', 'SUBMITTED', 'COMPLETED'] } } } }, _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: 10 }),
    ]);
    const productIds = [...new Set([...productGroups.map((row: any) => row.productId), ...orderGroups.map((row: any) => row.productId)])];
    const products = productIds.length ? await this.db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, websiteProductId: true, productName: true, productCode: true, categoryName: true } }) : [];
    const byProduct = new Map<string, any>();
    for (const row of productGroups) {
      const metric = byProduct.get(row.productId) ?? { searched: 0, discussed: 0, recommended: 0 };
      if (row.type === 'PRODUCT_SEARCHED') metric.searched += row._count._all;
      else if (row.type === 'PRODUCT_RECOMMENDED') metric.recommended += row._count._all;
      else metric.discussed += row._count._all;
      byProduct.set(row.productId, metric);
    }
    const ordered = new Map(orderGroups.map((row: any) => [row.productId, Number(row._sum.quantity ?? 0)]));
    const enriched = products.map((product: any) => ({
      ...product,
      searched: byProduct.get(product.id)?.searched ?? 0,
      discussed: byProduct.get(product.id)?.discussed ?? 0,
      recommended: byProduct.get(product.id)?.recommended ?? 0,
      orderedQuantity: ordered.get(product.id) ?? 0,
    }));
    const categoryCounts = new Map<string, number>();
    for (const product of enriched) if (product.categoryName) categoryCounts.set(product.categoryName, (categoryCounts.get(product.categoryName) ?? 0) + product.searched + product.discussed);
    const priceRanges = new Map<string, number>();
    for (const row of rangeRows) {
      const max = Number(row.maxPrice ?? row.minPrice ?? 0);
      const bucket = max <= 1000 ? 'up_to_1000' : max <= 2000 ? '1001_2000' : max <= 3000 ? '2001_3000' : 'above_3000';
      priceRanges.set(bucket, (priceRanges.get(bucket) ?? 0) + Number(row._count._all));
    }
    return {
      topSearchedProducts: [...enriched].sort((a, b) => b.searched - a.searched).slice(0, 10),
      mostDiscussedProducts: [...enriched].sort((a, b) => b.discussed - a.discussed).slice(0, 10),
      mostRecommendedProducts: [...enriched].sort((a, b) => b.recommended - a.recommended).slice(0, 10),
      mostOrderedProducts: [...enriched].filter((item) => item.orderedQuantity > 0).sort((a, b) => b.orderedQuantity - a.orderedQuantity).slice(0, 10),
      popularCategories: [...categoryCounts].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      commonRequestedSizes: sizeGroups.map((row: any) => ({ size: row.requestedSize, count: row._count._all })),
      commonPriceRanges: [...priceRanges].map(([range, count]) => ({ range, count })).sort((a, b) => b.count - a.count),
    };
  }

  async events(range: IntelligenceRange, page = 1, limit = 50) {
    const where = { createdAt: { gte: range.from, lt: range.to }, type: { in: [...activityTypes] } };
    const [items, total] = await Promise.all([
      this.db.customerActivity.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit, select: { id: true, type: true, summary: true, conversationId: true, orderId: true, product: { select: { websiteProductId: true, productCode: true } }, createdAt: true } }),
      this.db.customerActivity.count({ where }),
    ]);
    return { items, page, limit, total, pages: Math.ceil(total / limit) };
  }
}
