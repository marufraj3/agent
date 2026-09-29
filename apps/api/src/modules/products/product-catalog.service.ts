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

export interface CatalogProductVariation {
  websiteVariationId: number;
  websiteSizeId: number;
  sizeName: string;
  stockQuantity: number;
  active: boolean;
}

export interface CatalogSearchProduct {
  id: number;
  internalId: string;
  productName: string;
  productCode: string;
  slug: string;
  productStatus: string;
  active: boolean;
  sellPrice: string;
  discountPrice: string | null;
  flashSellPrice: string | null;
  isPreOrder: boolean;
  image: string | null;
  color: string | null;
  category: string | null;
  subCategory: string | null;
  variations: CatalogProductVariation[];
}

export type AvailabilityType = 'in_stock' | 'pre_order' | 'unavailable';

export interface ProductAvailability {
  id: number;
  productName: string;
  productCode: string;
  productStatus: string;
  active: boolean;
  presentInFeed: boolean;
  isPreOrder: boolean;
  sizes: Array<{
    websiteVariationId: number;
    websiteSizeId: number;
    sizeName: string;
    stock: number;
    active: boolean;
    orderable: boolean;
    availabilityType: AvailabilityType;
  }>;
}

export class ProductCatalogService {
  constructor(private readonly prisma: PrismaClient) {}

  async searchProducts(query: string, requestedLimit = 10): Promise<CatalogSearchProduct[]> {
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
      color: product.colorName,
      category: product.categoryName,
      subCategory: product.subCategoryName,
      variations: product.variations.map((variation) => ({
        websiteVariationId: variation.websiteVariationId,
        websiteSizeId: variation.websiteSizeId,
        sizeName: variation.sizeName,
        stockQuantity: variation.stockQuantity,
        active: variation.active,
      })),
    }));
  }

  async getProductAvailability(websiteProductId: number): Promise<ProductAvailability | null> {
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
      sizes: product.variations.map((variation) => {
        const orderable = isVariationOrderable({
          stockQuantity: variation.stockQuantity,
          variationActive: variation.active,
          productActive,
          isPreOrder: product.isPreOrder,
        });
        const availabilityType: AvailabilityType = !orderable
          ? 'unavailable'
          : variation.stockQuantity > 0
            ? 'in_stock'
            : 'pre_order';

        return {
          websiteVariationId: variation.websiteVariationId,
          websiteSizeId: variation.websiteSizeId,
          sizeName: variation.sizeName,
          stock: variation.stockQuantity,
          active: variation.active,
          orderable,
          availabilityType,
        };
      }),
    };
  }
}
