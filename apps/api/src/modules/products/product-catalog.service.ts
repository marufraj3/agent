import type { PrismaClient } from '@alzeena/database';

export function isKnownActiveProductStatus(status: string): boolean {
  // The observed feed uses "1" for active. Unknown source values fail closed rather
  // than being incorrectly exposed as orderable.
  return status === '1';
}

export function isVariationOrderable(input: {
  stockQuantity: number;
  variationActive: boolean;
  productActive: boolean;
  isPreOrder: boolean;
}): boolean {
  return (
    input.productActive &&
    input.variationActive &&
    (input.stockQuantity > 0 || input.isPreOrder)
  );
}

export class ProductCatalogService {
  constructor(private readonly prisma: PrismaClient) {}

  async searchProducts(query: string, requestedLimit = 10) {
    const normalizedQuery = query.trim().slice(0, 100);
    if (!normalizedQuery) return [];
    const limit = Math.min(Math.max(requestedLimit, 1), 50);

    const products = await this.prisma.product.findMany({
      where: {
        presentInFeed: true,
        OR: [
          { productName: { contains: normalizedQuery, mode: 'insensitive' } },
          { productCode: { contains: normalizedQuery, mode: 'insensitive' } },
          { slug: { contains: normalizedQuery, mode: 'insensitive' } },
        ],
      },
      include: {
        variations: { orderBy: [{ active: 'desc' }, { websiteSizeId: 'asc' }] },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    return products.map((product) => ({
      id: product.websiteProductId,
      internalId: product.id,
      productName: product.productName,
      productCode: product.productCode,
      slug: product.slug,
      productStatus: product.productStatus,
      active: isKnownActiveProductStatus(product.productStatus),
      sellPrice: product.sellPrice.toFixed(2),
      discountPrice: product.discountPrice?.toFixed(2) ?? null,
      flashSellPrice: product.flashSellPrice?.toFixed(2) ?? null,
      isPreOrder: product.isPreOrder,
      image: product.productImage,
      variations: product.variations.map((variation) => ({
        websiteVariationId: variation.websiteVariationId,
        websiteSizeId: variation.websiteSizeId,
        sizeName: variation.sizeName,
        stockQuantity: variation.stockQuantity,
        active: variation.active,
      })),
    }));
  }

  async getProductAvailability(websiteProductId: number) {
    const product = await this.prisma.product.findUnique({
      where: { websiteProductId },
      include: { variations: { orderBy: { websiteSizeId: 'asc' } } },
    });

    if (!product) return null;

    const productActive = product.presentInFeed && isKnownActiveProductStatus(product.productStatus);
    return {
      id: product.websiteProductId,
      productName: product.productName,
      productCode: product.productCode,
      productStatus: product.productStatus,
      active: productActive,
      presentInFeed: product.presentInFeed,
      isPreOrder: product.isPreOrder,
      sizes: product.variations.map((variation) => ({
        websiteVariationId: variation.websiteVariationId,
        websiteSizeId: variation.websiteSizeId,
        sizeName: variation.sizeName,
        stock: variation.stockQuantity,
        active: variation.active,
        orderable: isVariationOrderable({
          stockQuantity: variation.stockQuantity,
          variationActive: variation.active,
          productActive,
          isPreOrder: product.isPreOrder,
        }),
      })),
    };
  }
}
